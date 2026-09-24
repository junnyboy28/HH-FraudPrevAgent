// EvidenceSource backed by the installed GSQL queries on TigerGraph.
//
// Same interface as LocalEvidenceSource, so the orchestrator, pattern detection
// and policy engine are unchanged: only where the evidence comes from differs.
// Select it with EVIDENCE_SOURCE=tigergraph, or `npm run benchmark -- --tigergraph`.
//
// Each method maps to one compiled query in graph/queries/, so an evidence
// item's `ref` names a query that genuinely ran against the graph.
//
// Two pieces of judgement stay on this side rather than in GSQL, deliberately:
// device-profile specificity and the ring/strong/moderate grading. They encode
// what the data taught us (a profile shared by 1,013 cards is a laptop model,
// not a fingerprint) and are identical to the local source so the two backends
// agree.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TigerGraphMcpClient } from './tigergraph-mcp-client.js';
import type {
  AccountProfile,
  CasePackEntry,
  ClosedCase,
  DeviceLinkStrength,
  EvidenceSource,
  LinkedFraud,
  Neighborhood,
  SharedDeviceLink,
  SimilarCase,
  Txn,
} from './evidence-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data', 'HHGOA_IEEE');
const GRAPH = 'FraudGraph';

const DEVICE_SHARED_MAX_CARDS = 3;
const DEVICE_GENERIC_MAX_CARDS = 10;
const DEVICE_RING_MAX_CARDS = 400;
const MAX_SHARED_LINKS = 60;
const PLATFORM_WORDS = /^(windows|macos|mac os|ios device|linux|android|trident\/|rv:|other|nokia|blackberry)$/i;

function isConcreteDeviceProfile(profile: string): boolean {
  const info = (profile.split('|')[0] ?? '').trim();
  if (info === '') return false;
  if (PLATFORM_WORDS.test(info)) return false;
  return /build\//i.test(info) || /[A-Za-z]+[-_ ]?[A-Za-z]*\d{2,}/.test(info);
}

function profileIsIdentifying(profile: string): boolean {
  return profile.split('|').filter((p) => p.trim() !== '').length >= 2;
}

function strengthFor(profile: string, nCards: number): DeviceLinkStrength {
  if (!profileIsIdentifying(profile)) return 'generic';
  if (nCards <= DEVICE_SHARED_MAX_CARDS) return 'strong';
  if (isConcreteDeviceProfile(profile) && nCards <= DEVICE_RING_MAX_CARDS) return 'ring';
  if (nCards <= DEVICE_GENERIC_MAX_CARDS) return 'moderate';
  return 'generic';
}

function envVar(name: string): string {
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      if (line.slice(0, line.indexOf('=')).trim() === name) return line.slice(line.indexOf('=') + 1).trim();
    }
  } catch {
    return '';
  }
  return '';
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

interface QueryResult {
  readonly error?: boolean;
  readonly message?: string;
  readonly results?: Record<string, unknown>[];
}

export class TigerGraphEvidenceSource implements EvidenceSource {
  readonly kind = 'tigergraph' as const;

  private token: string | null = null;
  private casePack: CasePackEntry[] | null = null;
  private readonly deviceCards = new Map<string, number>();
  private readonly txnCache = new Map<string, Txn>();

  /**
   * With an MCP client supplied, the compiled GSQL queries run through the
   * TigerGraph MCP server instead of our own REST calls. The parsing below is
   * identical either way, so both transports return the same evidence and the
   * orchestrator cannot tell them apart.
   */
  constructor(
    private readonly host = envVar('TIGERGRAPH_HOST').replace(/\/$/, ''),
    private readonly secret = envVar('TIGERGRAPH_TOKEN'),
    private readonly mcp: TigerGraphMcpClient | null = null,
  ) {}

  /** Which transport the graph reads go over, for the record in the case trace. */
  get transport(): 'mcp' | 'rest' {
    return this.mcp === null ? 'rest' : 'mcp';
  }

  static isConfigured(): boolean {
    return envVar('TIGERGRAPH_HOST') !== '' && envVar('TIGERGRAPH_TOKEN') !== '';
  }

  private async auth(): Promise<string> {
    if (this.token !== null) return this.token;
    const res = await fetch(`${this.host}/gsql/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.secret, lifetime: '2592000' }),
    });
    const body = (await res.json()) as { token?: string; message?: string };
    if (!body.token) throw new Error(`TigerGraph auth failed: ${body.message ?? ''}`);
    this.token = body.token;
    return body.token;
  }

  /**
   * Runs an installed GSQL query and returns its PRINTed result blocks, either
   * through TigerGraph MCP or directly over REST.
   */
  private async runQuery(name: string, params: Record<string, string | number>): Promise<Record<string, unknown>[]> {
    if (this.mcp !== null) return this.runQueryViaMcp(name, params);
    const tok = await this.auth();
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await fetch(`${this.host}/restpp/query/${GRAPH}/${name}?${qs}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const body = (await res.json()) as QueryResult;
    if (body.error === true) throw new Error(`GSQL ${name} failed: ${body.message ?? ''}`);
    return body.results ?? [];
  }

  /**
   * The MCP server wraps a query's output in an envelope and returns it as text
   * in a fenced JSON block, so it is unwrapped back to the same result blocks
   * the REST path produces.
   */
  private async runQueryViaMcp(
    name: string,
    params: Record<string, string | number>,
  ): Promise<Record<string, unknown>[]> {
    const mcp = this.mcp;
    if (mcp === null) throw new Error('no MCP client');
    const raw = await mcp.runInstalledQuery(name, params);
    const parsed = typeof raw === 'string' ? this.unwrapFenced(raw) : raw;
    const envelope = parsed as {
      success?: boolean;
      summary?: string;
      data?: { result?: Record<string, unknown>[] };
    };
    if (envelope.success === false) {
      throw new Error(`MCP query ${name} failed: ${envelope.summary ?? 'unknown error'}`);
    }
    return envelope.data?.result ?? [];
  }

  /** Pulls JSON out of a ```json fenced block, which is how the server replies. */
  private unwrapFenced(text: string): unknown {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const body = fenced?.[1] ?? text;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return {};
    }
  }

  private block(results: Record<string, unknown>[], key: string): unknown {
    for (const r of results) if (key in r) return r[key];
    return undefined;
  }

  /** How many cards use each device profile, needed to grade a shared link. */
  private async cardsOnProfile(profile: string): Promise<number> {
    const cached = this.deviceCards.get(profile);
    if (cached !== undefined) return cached;
    const tok = await this.auth();
    const res = await fetch(
      `${this.host}/restpp/graph/${GRAPH}/vertices/DeviceProfile/${encodeURIComponent(profile)}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    const body = (await res.json()) as { results?: { attributes?: { n_cards?: number } }[] };
    const n = num(body.results?.[0]?.attributes?.n_cards, 0);
    this.deviceCards.set(profile, n);
    return n;
  }

  private rowToTxn(row: Record<string, unknown>, accountId: string, cardId: string): Txn {
    return {
      txnId: str(row['txn_id']),
      accountId,
      cardId,
      dt: num(row['transaction_dt']),
      ts: str(row['ts']).replace('T', ' ').slice(0, 19),
      amount: num(row['amount']),
      productCd: str(row['product_cd']),
      channel: str(row['channel']),
      riskScore: num(row['risk_score'], -1),
      addr1: str(row['addr1']),
      addr2: str(row['addr2']),
      pEmailDomain: str(row['p_emaildomain']),
      hasIdentity: row['has_identity'] === true || row['has_identity'] === 'true',
      deviceProfile: str(row['device_profile']),
      deviceNew: str(row['device_new']),
      proxy: str(row['proxy']),
      matchStatus: str(row['match_status']),
    };
  }

  async getCardTimeline(cardId: string): Promise<readonly Txn[]> {
    const results = await this.runQuery('getCardTimeline', { card: cardId, max_txns: 2000 });
    const rows = (this.block(results, 'timeline') ?? []) as Record<string, unknown>[];
    const accountId = cardId.split('-')[0] ?? '';
    const txns = rows.map((r) => this.rowToTxn(r, accountId, cardId)).sort((a, b) => a.dt - b.dt);
    for (const t of txns) this.txnCache.set(t.txnId, t);
    return txns;
  }

  async getEntityNeighborhood(txnId: string): Promise<Neighborhood> {
    const results = await this.runQuery('getEntityNeighborhood', { flagged: txnId });
    const txnRows = (this.block(results, 'txn') ?? []) as { v_id?: string; attributes?: Record<string, unknown> }[];
    const attrs = txnRows[0]?.attributes;
    if (attrs === undefined) throw new Error(`Transaction ${txnId} not found in the graph`);

    const cardRows = (this.block(results, 'card') ?? []) as { v_id?: string }[];
    const acctRows = (this.block(results, 'account') ?? []) as { v_id?: string }[];
    const sibRows = (this.block(results, 'siblingCards') ?? []) as { v_id?: string }[];
    const devRows = (this.block(results, 'device') ?? []) as { v_id?: string }[];
    const regionRows = (this.block(results, 'region') ?? []) as { v_id?: string }[];
    const emailRows = (this.block(results, 'emailDomain') ?? []) as { v_id?: string }[];
    const linkedRows = (this.block(results, 'linkedAccounts') ?? []) as { v_id?: string }[];
    const caseRows = (this.block(results, 'existingCases') ?? []) as { v_id?: string }[];

    const cardId = str(cardRows[0]?.v_id ?? attrs['card_id']);
    const accountId = str(acctRows[0]?.v_id ?? attrs['account_id']);
    const deviceProfile = str(devRows[0]?.v_id ?? '');

    // The neighbourhood query returns the transaction vertex, which carries the
    // columns but not the identity signals. Those hang off the USED_DEVICE edge
    // and come back on the timeline, so take them from there when present.
    const flaggedFromTimeline = this.txnCache.get(txnId);
    const flagged: Txn = flaggedFromTimeline ?? {
      txnId,
      accountId,
      cardId,
      dt: num(attrs['transaction_dt']),
      ts: str(attrs['ts']).replace('T', ' ').slice(0, 19),
      amount: num(attrs['amount']),
      productCd: str(attrs['product_cd']),
      channel: str(attrs['channel']),
      riskScore: num(attrs['risk_score'], -1),
      addr1: str(attrs['addr1']),
      addr2: str(attrs['addr2']),
      pEmailDomain: str(attrs['p_emaildomain']),
      hasIdentity: attrs['has_identity'] === true,
      deviceProfile,
      deviceNew: '',
      proxy: '',
      matchStatus: '',
    };
    this.txnCache.set(txnId, flagged);

    return {
      flagged,
      cardId,
      accountId,
      siblingCardIds: sibRows.map((r) => str(r.v_id)).filter((c) => c !== '' && c !== cardId),
      deviceProfile,
      region: str(regionRows[0]?.v_id ?? attrs['addr1']),
      emailDomain: str(emailRows[0]?.v_id ?? attrs['p_emaildomain']),
      deviceLinkedAccountIds: linkedRows.map((r) => str(r.v_id)).filter((a) => a !== accountId),
      existingCaseIds: caseRows.map((r) => str(r.v_id)),
    };
  }

  async getAccountProfile(accountId: string): Promise<AccountProfile> {
    const results = await this.runQuery('getAccountProfile', { cust: accountId });
    const cards = (this.block(results, 'cards') ?? []) as string[];
    const regions = (this.block(results, 'billing_regions_used') ?? []) as string[];
    const channels = (this.block(results, 'channels_used') ?? []) as string[];
    const products = (this.block(results, 'product_codes_used') ?? []) as string[];
    const emails = (this.block(results, 'email_domains_used') ?? []) as string[];
    const devices = (this.block(results, 'device_profiles_used') ?? []) as string[];
    const nTxns = num(this.block(results, 'n_transactions'));
    const minAmount = num(this.block(results, 'min_amount'));
    const maxAmount = num(this.block(results, 'max_amount'));
    const total = num(this.block(results, 'total_amount'));

    // The graph returns the aggregate, not the distribution, so the median is
    // approximated by the mean. Only used as a "fits their history" yardstick.
    const mean = nTxns > 0 ? total / nTxns : 0;

    const acctRows = (this.block(results, 'acct') ?? []) as { attributes?: Record<string, unknown> }[];
    const a = acctRows[0]?.attributes ?? {};

    return {
      accountId,
      cardIds: cards.filter((c) => c !== ''),
      nTransactions: nTxns,
      firstSeen: str(a['first_seen']).replace('T', ' ').slice(0, 19),
      lastSeen: str(a['last_seen']).replace('T', ' ').slice(0, 19),
      regionsUsed: regions.filter((r) => r !== ''),
      channelsUsed: channels.filter((c) => c !== ''),
      productCodesUsed: products.filter((p) => p !== ''),
      emailDomainsUsed: emails.filter((e) => e !== ''),
      deviceProfilesUsed: devices.filter((d) => d !== ''),
      minAmount,
      maxAmount,
      medianAmount: mean,
    };
  }

  async findSharedDevicesAcrossAccounts(accountId: string): Promise<readonly SharedDeviceLink[]> {
    const results = await this.runQuery('findSharedDevicesAcrossAccounts', { cust: accountId });
    const rows = (this.block(results, 'shared_device_links') ?? []) as Record<string, unknown>[];
    const out: SharedDeviceLink[] = [];
    for (const r of rows) {
      const profile = str(r['device_profile']);
      const nCards = await this.cardsOnProfile(profile);
      const strength = strengthFor(profile, nCards);
      if (strength === 'generic') continue;
      out.push({
        deviceProfile: profile,
        otherAccountId: str(r['other_account_id']),
        nTransactions: num(r['n_transactions']),
        firstSeen: str(r['first_seen']).replace('T', ' ').slice(0, 19),
        lastSeen: str(r['last_seen']).replace('T', ' ').slice(0, 19),
        nCardsOnProfile: nCards,
        isConcreteDevice: isConcreteDeviceProfile(profile),
        strength,
      });
    }
    const rank: Record<DeviceLinkStrength, number> = { strong: 0, ring: 1, moderate: 2, generic: 3 };
    return out
      .sort((a, b) => rank[a.strength] - rank[b.strength] || a.nCardsOnProfile - b.nCardsOnProfile)
      .slice(0, MAX_SHARED_LINKS);
  }

  private rowToCase(r: Record<string, unknown>): ClosedCase {
    return {
      caseId: str(r['case_id']),
      accountId: str(r['account_id']),
      cardId: str(r['card_id']),
      openedAt: str(r['opened_at']).replace('T', ' ').slice(0, 19),
      closedAt: '',
      outcome: str(r['outcome']),
      pattern: str(r['pattern']),
      firstFraudTxnId: '',
      txnIds: [],
      exposureUsd: num(r['exposure_usd']),
      connectedCardIds: [],
      actionsTaken: str(r['actions_taken']).split('|').filter((x) => x !== ''),
      reportFiled: str(r['report_filed']),
      analystNotes: '',
    };
  }

  /**
   * Prior confirmed fraud reachable from this account.
   *
   * The query is run with a wide device ceiling so concrete-handset rings are
   * not excluded (the HHG-014 ring profile carries 51 cards), then the returned
   * cases are narrowed to accounts that survive the specificity grading in
   * findSharedDevicesAcrossAccounts. GSQL has no cheap way to express "is this
   * a concrete device build", so that half of the test stays here, and the two
   * backends agree exactly as a result.
   */
  async findLinkedFraudHistory(accountId: string): Promise<LinkedFraud> {
    const [results, shared] = await Promise.all([
      this.runQuery('findLinkedFraudHistory', { cust: accountId, max_cards_on_profile: DEVICE_RING_MAX_CARDS }),
      this.findSharedDevicesAcrossAccounts(accountId),
    ]);
    const direct = ((this.block(results, 'direct_fraud_cases') ?? []) as Record<string, unknown>[]).map((r) =>
      this.rowToCase(r),
    );
    const linkedAccounts = new Set(shared.map((s) => s.otherAccountId));
    const via = ((this.block(results, 'fraud_cases_via_shared_device') ?? []) as Record<string, unknown>[])
      .map((r) => this.rowToCase(r))
      .filter((c) => linkedAccounts.has(c.accountId));
    const seen = new Set(direct.map((c) => c.caseId));
    return { direct, viaSharedDevice: via.filter((c) => !seen.has(c.caseId)) };
  }

  /**
   * findSimilarClosedCases is still a draft on the server, so similarity is
   * assembled here from the two queries that are installed: cases on accounts
   * sharing an identifying device, scored the same way the local source scores
   * them. Same inputs, same ranking, one fewer compiled query.
   */
  async findSimilarClosedCases(
    accountId: string,
    pattern: string,
    _region: string,
    topK: number,
  ): Promise<readonly SimilarCase[]> {
    const linked = await this.findLinkedFraudHistory(accountId);
    const scored = new Map<string, { c: ClosedCase; score: number; basis: Set<string> }>();
    const bump = (c: ClosedCase, points: number, why: string): void => {
      let e = scored.get(c.caseId);
      if (!e) {
        e = { c, score: 0, basis: new Set<string>() };
        scored.set(c.caseId, e);
      }
      if (e.basis.has(why)) return;
      e.basis.add(why);
      e.score += points;
    };
    for (const c of linked.viaSharedDevice) bump(c, 3, 'shared_device');
    for (const c of linked.direct) bump(c, 3, 'same_account');
    if (pattern !== '' && pattern !== 'none') {
      for (const e of scored.values()) if (e.c.pattern === pattern) bump(e.c, 1, 'same_pattern');
    }
    for (const e of scored.values()) if (e.c.outcome === 'confirmed_fraud') e.score += 1;
    return [...scored.values()]
      .sort((a, b) => b.score - a.score || (a.c.caseId < b.c.caseId ? -1 : 1))
      .slice(0, topK)
      .map(({ c, score, basis }) => ({ ...c, score, basis: [...basis] }));
  }

  async getDeviceCohort(deviceProfile: string, aroundTs: string, days: number): Promise<readonly string[]> {
    if (deviceProfile === '') return [];
    const tok = await this.auth();
    const res = await fetch(
      `${this.host}/restpp/graph/${GRAPH}/edges/DeviceProfile/${encodeURIComponent(deviceProfile)}/SHARED_BY?limit=1000`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    const body = (await res.json()) as {
      results?: { to_id?: string; attributes?: { first_seen?: string; last_seen?: string } }[];
    };
    const centre = Date.parse(aroundTs.replace(' ', 'T') + 'Z');
    const windowMs = days * 86400 * 1000;
    const out = new Set<string>();
    for (const e of body.results ?? []) {
      const first = Date.parse(str(e.attributes?.first_seen).replace(' ', 'T'));
      const last = Date.parse(str(e.attributes?.last_seen).replace(' ', 'T'));
      if (Number.isNaN(centre) || Number.isNaN(first) || Number.isNaN(last)) {
        out.add(str(e.to_id));
        continue;
      }
      if (last >= centre - windowMs && first <= centre + windowMs) out.add(str(e.to_id));
    }
    return [...out];
  }

  /** The exam input, not graph data, so it is read from the dataset file. */
  async getCasePack(): Promise<readonly CasePackEntry[]> {
    if (this.casePack !== null) return this.casePack;
    const lines = readFileSync(path.join(DATA_DIR, 'case_pack.csv'), 'utf8').split(/\r?\n/);
    const cols = new Map<string, number>();
    splitCsv(lines[0] ?? '').forEach((h, i) => cols.set(h.trim(), i));
    const at = (f: string[], name: string): string => {
      const i = cols.get(name);
      return i === undefined ? '' : (f[i] ?? '');
    };
    const out: CasePackEntry[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim() === '') continue;
      const f = splitCsv(line);
      const risk = at(f, 'risk_score');
      out.push({
        caseId: at(f, 'case_id'),
        openedAt: at(f, 'opened_at'),
        triggerType: at(f, 'trigger_type'),
        triggerText: at(f, 'trigger_text'),
        flaggedTxnId: at(f, 'flagged_txn_id'),
        cardId: at(f, 'card_id'),
        customerId: at(f, 'customer_id'),
        riskScore: risk === '' ? null : Number(risk),
      });
    }
    this.casePack = out;
    return out;
  }

  async txnExists(txnId: string): Promise<boolean> {
    if (this.txnCache.has(txnId)) return true;
    const tok = await this.auth();
    const res = await fetch(`${this.host}/restpp/graph/${GRAPH}/vertices/Transaction/${encodeURIComponent(txnId)}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const body = (await res.json()) as { error?: boolean; results?: unknown[] };
    return body.error !== true && (body.results?.length ?? 0) > 0;
  }
}
