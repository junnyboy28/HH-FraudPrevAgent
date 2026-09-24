// EvidenceSource backed by the prepared CSVs in graph/load/prepared/full/.
//
// This exists so the orchestrator, pattern detection and answer-file writer can
// be built and tested without a live TigerGraph. The submission runs against
// TigerGraph; this is the development harness and the fallback. Both backends
// return identical shapes, so swapping them changes nothing downstream.
//
// Memory matters here: transactions.csv holds 590,742 rows and this build runs
// on a machine with very little headroom. So rather than loading everything,
// the loader works out which accounts an investigation can possibly reach (the
// case-pack accounts, plus every account sharing a device profile with them)
// and keeps only those transactions in memory.

import { createReadStream, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DeviceLinkStrength,
  AccountProfile,
  CasePackEntry,
  ClosedCase,
  EvidenceSource,
  LinkedFraud,
  Neighborhood,
  SharedDeviceLink,
  SimilarCase,
  Txn,
} from './evidence-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PREPARED = path.join(REPO_ROOT, 'graph', 'load', 'prepared', 'full');
const DATA_DIR = path.join(REPO_ROOT, 'data', 'HHGOA_IEEE');

/** Splits a quoted CSV line. The prepared files quote every field. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function eachRow(
  file: string,
  onRow: (cols: Map<string, number>, f: readonly string[]) => void,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const cols = new Map<string, number>();
  let first = true;
  for await (const line of rl) {
    if (line === '') continue;
    const f = splitCsv(line);
    if (first) {
      f.forEach((h, i) => cols.set(h, i));
      first = false;
      continue;
    }
    onRow(cols, f);
  }
  rl.close();
}

function at(f: readonly string[], cols: Map<string, number>, name: string): string {
  const i = cols.get(name);
  return i === undefined ? '' : (f[i] ?? '');
}

/** Few enough cards that the profile plausibly is one physical device. */
const DEVICE_SHARED_MAX_CARDS = 3;
/** Above this, a non-concrete profile is a device type and identifies nothing. */
const DEVICE_GENERIC_MAX_CARDS = 10;
/**
 * Above this many cards even a concrete device build stops being a ring and
 * starts being a popular handset. 1,013 cards on one profile is the dataset
 * maximum and is the empty profile.
 */
const DEVICE_RING_MAX_CARDS = 400;
/** Cap on links returned, so one device-promiscuous account cannot flood a bundle. */
const MAX_SHARED_LINKS = 60;

/**
 * Platform strings that appear in the DeviceInfo slot but do not name a device.
 * "Windows" is an operating system, "rv:58.0" is a Gecko version, "iOS Device"
 * is what Vesta records when it knows only that it was an iPhone.
 */
const PLATFORM_WORDS = /^(windows|macos|mac os|ios device|linux|android|trident\/|rv:|other|nokia|blackberry)$/i;

/**
 * True when the DeviceInfo component names a concrete device build, such as
 * "SM-G935F Build/NRD90M" or "SAMSUNG SM-G892A Build/NRD90M". This is the
 * difference between a fraud ring and a common laptop: 51 cardholders on one
 * specific phone build is anomalous, 842 on "Windows 10 + Chrome" is not.
 */
function isConcreteDeviceProfile(profile: string): boolean {
  const info = (profile.split('|')[0] ?? '').trim();
  if (info === '') return false;
  if (PLATFORM_WORDS.test(info)) return false;
  // A build string, or a model code with digits (SM-G935F, LG-K500, TRT-L53).
  return /build\//i.test(info) || /[A-Za-z]+[-_ ]?[A-Za-z]*\d{2,}/.test(info);
}

/**
 * True when the profile carries enough detail to identify anything at all. The
 * load joins four identity columns with " | ", and many rows leave most of them
 * blank, so a profile can be " |  |  |" and match 1,013 cards.
 */
function profileIsIdentifying(profile: string): boolean {
  const populated = profile.split('|').filter((p) => p.trim() !== '').length;
  return populated >= 2;
}

function strengthFor(profile: string, nCards: number): DeviceLinkStrength {
  if (!profileIsIdentifying(profile)) return 'generic';
  if (nCards <= DEVICE_SHARED_MAX_CARDS) return 'strong';
  const concrete = isConcreteDeviceProfile(profile);
  if (concrete && nCards <= DEVICE_RING_MAX_CARDS) return 'ring';
  if (nCards <= DEVICE_GENERIC_MAX_CARDS) return 'moderate';
  return 'generic';
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export class LocalEvidenceSource implements EvidenceSource {
  readonly kind = 'local-csv' as const;

  private readonly txnsByCard = new Map<string, Txn[]>();
  private readonly txnById = new Map<string, Txn>();
  private readonly cardsByAccount = new Map<string, Set<string>>();
  private readonly devicesByAccount = new Map<string, Set<string>>();
  private readonly accountsByDevice = new Map<string, Set<string>>();
  private readonly sharedLinks = new Map<string, SharedDeviceLink[]>();
  private readonly cardsOnProfile = new Map<string, number>();
  private readonly closedCases: ClosedCase[] = [];
  private readonly casesByAccount = new Map<string, ClosedCase[]>();
  private readonly casesByTxn = new Map<string, string[]>();
  private readonly allTxnIds = new Set<string>();
  private casePack: CasePackEntry[] = [];
  private loaded = false;

  /** Loads the slice of the dataset an investigation can reach. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (!existsSync(PREPARED)) {
      throw new Error(
        `Prepared CSVs not found at ${PREPARED}. Run "npm run prep:full" first.`,
      );
    }

    this.casePack = this.readCasePack();

    // 0. How many cards use each device profile. This is what decides whether a
    //    shared profile is evidence or just a common browser string.
    await eachRow(path.join(PREPARED, 'devices.csv'), (cols, f) => {
      this.cardsOnProfile.set(
        at(f, cols, 'device_profile'),
        Number(at(f, cols, 'n_cards') || '0'),
      );
    });

    // 1. Device to account map, from the materialized SHARED_BY edges.
    await eachRow(path.join(PREPARED, 'e_shared_by.csv'), (cols, f) => {
      const device = at(f, cols, 'device_profile');
      const account = at(f, cols, 'account_id');
      let accs = this.accountsByDevice.get(device);
      if (!accs) {
        accs = new Set<string>();
        this.accountsByDevice.set(device, accs);
      }
      accs.add(account);
      let devs = this.devicesByAccount.get(account);
      if (!devs) {
        devs = new Set<string>();
        this.devicesByAccount.set(account, devs);
      }
      devs.add(device);
      const nCards = this.cardsOnProfile.get(device) ?? 0;
      const link: SharedDeviceLink = {
        deviceProfile: device,
        otherAccountId: account,
        nTransactions: Number(at(f, cols, 'n_transactions') || '0'),
        firstSeen: at(f, cols, 'first_seen'),
        lastSeen: at(f, cols, 'last_seen'),
        nCardsOnProfile: nCards,
        isConcreteDevice: isConcreteDeviceProfile(device),
        strength: strengthFor(device, nCards),
      };
      const list = this.sharedLinks.get(device);
      if (list) list.push(link);
      else this.sharedLinks.set(device, [link]);
    });

    // 2. Which accounts can this investigation reach? The case-pack accounts,
    //    plus anyone sharing a device profile with them.
    const relevant = new Set<string>(this.casePack.map((c) => c.customerId));
    for (const caseEntry of this.casePack) {
      for (const device of this.devicesByAccount.get(caseEntry.customerId) ?? []) {
        for (const other of this.accountsByDevice.get(device) ?? []) relevant.add(other);
      }
    }

    // 3. Closed cases, all of them: needed as case memory regardless of account.
    await eachRow(path.join(PREPARED, 'cases.csv'), (cols, f) => {
      const c: ClosedCase = {
        caseId: at(f, cols, 'case_id'),
        accountId: at(f, cols, 'account_id'),
        cardId: at(f, cols, 'card_id'),
        openedAt: at(f, cols, 'opened_at'),
        closedAt: at(f, cols, 'closed_at'),
        outcome: at(f, cols, 'outcome'),
        pattern: at(f, cols, 'pattern'),
        firstFraudTxnId: at(f, cols, 'first_fraud_txn_id'),
        txnIds: [],
        exposureUsd: Number(at(f, cols, 'exposure_usd') || '0'),
        connectedCardIds: [],
        actionsTaken: at(f, cols, 'actions_taken').split('|').filter((x) => x !== ''),
        reportFiled: at(f, cols, 'report_filed'),
        analystNotes: at(f, cols, 'analyst_notes'),
      };
      this.closedCases.push(c);
      const list = this.casesByAccount.get(c.accountId);
      if (list) list.push(c);
      else this.casesByAccount.set(c.accountId, [c]);
      // Any account owning a closed case is worth having transactions for: it is
      // how a case becomes citable evidence.
      relevant.add(c.accountId);
    });

    const caseById = new Map(this.closedCases.map((c) => [c.caseId, c]));
    const txnsOfCase = new Map<string, string[]>();
    await eachRow(path.join(PREPARED, 'e_involves.csv'), (cols, f) => {
      const caseId = at(f, cols, 'case_id');
      const txnId = at(f, cols, 'txn_id');
      const list = txnsOfCase.get(caseId);
      if (list) list.push(txnId);
      else txnsOfCase.set(caseId, [txnId]);
      const cases = this.casesByTxn.get(txnId);
      if (cases) cases.push(caseId);
      else this.casesByTxn.set(txnId, [caseId]);
    });
    for (const [caseId, txnIds] of txnsOfCase) {
      const c = caseById.get(caseId);
      if (c) (c as { txnIds: readonly string[] }).txnIds = txnIds;
    }

    await eachRow(path.join(PREPARED, 'e_connected_to.csv'), (cols, f) => {
      const c = caseById.get(at(f, cols, 'case_id'));
      if (!c) return;
      (c as { connectedCardIds: readonly string[] }).connectedCardIds = [
        ...c.connectedCardIds,
        at(f, cols, 'card_id'),
      ];
    });

    // 4. Device and identity signals per transaction, kept only for the
    //    transactions we are about to load.
    const deviceOfTxn = new Map<string, { profile: string; isNew: string; proxy: string; match: string }>();
    await eachRow(path.join(PREPARED, 'e_used_device.csv'), (cols, f) => {
      deviceOfTxn.set(at(f, cols, 'txn_id'), {
        profile: at(f, cols, 'device_profile'),
        isNew: at(f, cols, 'id_15'),
        proxy: at(f, cols, 'id_23'),
        match: at(f, cols, 'id_34'),
      });
    });

    // 5. Transactions, filtered to the reachable accounts.
    await eachRow(path.join(PREPARED, 'transactions.csv'), (cols, f) => {
      const txnId = at(f, cols, 'txn_id');
      this.allTxnIds.add(txnId);
      const accountId = at(f, cols, 'account_id');
      if (!relevant.has(accountId)) return;
      const cardId = at(f, cols, 'card_id');
      const d = deviceOfTxn.get(txnId);
      const txn: Txn = {
        txnId,
        accountId,
        cardId,
        dt: Number(at(f, cols, 'transaction_dt') || '0'),
        ts: at(f, cols, 'ts'),
        amount: Number(at(f, cols, 'amount') || '0'),
        productCd: at(f, cols, 'product_cd'),
        channel: at(f, cols, 'channel'),
        riskScore: Number(at(f, cols, 'risk_score') || '-1'),
        addr1: at(f, cols, 'addr1'),
        addr2: at(f, cols, 'addr2'),
        pEmailDomain: at(f, cols, 'p_emaildomain'),
        hasIdentity: at(f, cols, 'has_identity') === 'true',
        deviceProfile: d?.profile ?? '',
        deviceNew: d?.isNew ?? '',
        proxy: d?.proxy ?? '',
        matchStatus: d?.match ?? '',
      };
      this.txnById.set(txnId, txn);
      const list = this.txnsByCard.get(cardId);
      if (list) list.push(txn);
      else this.txnsByCard.set(cardId, [txn]);
      let cards = this.cardsByAccount.get(accountId);
      if (!cards) {
        cards = new Set<string>();
        this.cardsByAccount.set(accountId, cards);
      }
      cards.add(cardId);
    });

    for (const list of this.txnsByCard.values()) {
      list.sort((a, b) => a.dt - b.dt || (a.txnId < b.txnId ? -1 : 1));
    }

    this.loaded = true;
  }

  private readCasePack(): CasePackEntry[] {
    const file = path.join(DATA_DIR, 'case_pack.csv');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const cols = new Map<string, number>();
    splitCsv(lines[0] ?? '').forEach((h, i) => cols.set(h.trim(), i));
    const out: CasePackEntry[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim() === '') continue;
      const f = splitCsv(line);
      const risk = at(f, cols, 'risk_score');
      out.push({
        caseId: at(f, cols, 'case_id'),
        openedAt: at(f, cols, 'opened_at'),
        triggerType: at(f, cols, 'trigger_type'),
        triggerText: at(f, cols, 'trigger_text'),
        flaggedTxnId: at(f, cols, 'flagged_txn_id'),
        cardId: at(f, cols, 'card_id'),
        customerId: at(f, cols, 'customer_id'),
        riskScore: risk === '' ? null : Number(risk),
      });
    }
    return out;
  }

  async getCasePack(): Promise<readonly CasePackEntry[]> {
    await this.load();
    return this.casePack;
  }

  async txnExists(txnId: string): Promise<boolean> {
    await this.load();
    return this.allTxnIds.has(txnId);
  }

  async getCardTimeline(cardId: string): Promise<readonly Txn[]> {
    await this.load();
    return this.txnsByCard.get(cardId) ?? [];
  }

  async getEntityNeighborhood(txnId: string): Promise<Neighborhood> {
    await this.load();
    const flagged = this.txnById.get(txnId);
    if (!flagged) throw new Error(`Transaction ${txnId} not loaded`);
    const linked = new Set<string>();
    if (flagged.deviceProfile !== '') {
      for (const acc of this.accountsByDevice.get(flagged.deviceProfile) ?? []) {
        if (acc !== flagged.accountId) linked.add(acc);
      }
    }
    return {
      flagged,
      cardId: flagged.cardId,
      accountId: flagged.accountId,
      siblingCardIds: [...(this.cardsByAccount.get(flagged.accountId) ?? [])].filter(
        (c) => c !== flagged.cardId,
      ),
      deviceProfile: flagged.deviceProfile,
      region: flagged.addr1,
      emailDomain: flagged.pEmailDomain,
      deviceLinkedAccountIds: [...linked],
      existingCaseIds: this.casesByTxn.get(txnId) ?? [],
    };
  }

  async getAccountProfile(accountId: string): Promise<AccountProfile> {
    await this.load();
    const cardIds = [...(this.cardsByAccount.get(accountId) ?? [])];
    const txns: Txn[] = [];
    for (const cardId of cardIds) txns.push(...(this.txnsByCard.get(cardId) ?? []));
    txns.sort((a, b) => a.dt - b.dt);
    const amounts = txns.map((t) => t.amount);
    const uniq = (xs: readonly string[]): string[] => [...new Set(xs.filter((x) => x !== ''))];
    return {
      accountId,
      cardIds,
      nTransactions: txns.length,
      firstSeen: txns[0]?.ts ?? '',
      lastSeen: txns[txns.length - 1]?.ts ?? '',
      regionsUsed: uniq(txns.map((t) => t.addr1)),
      channelsUsed: uniq(txns.map((t) => t.channel)),
      productCodesUsed: uniq(txns.map((t) => t.productCd)),
      emailDomainsUsed: uniq(txns.map((t) => t.pEmailDomain)),
      deviceProfilesUsed: uniq(txns.map((t) => t.deviceProfile)),
      minAmount: amounts.length ? Math.min(...amounts) : 0,
      maxAmount: amounts.length ? Math.max(...amounts) : 0,
      medianAmount: median(amounts),
    };
  }

  /**
   * Device profiles this account shares with others, restricted to profiles
   * that actually identify a device. Generic profiles are dropped rather than
   * returned and left for a caller to filter: they are not weak evidence, they
   * are no evidence, and one of them covers 1,013 cards.
   *
   * Strongest links first, so an evidence bundle that gets truncated keeps the
   * ones that matter.
   */
  async findSharedDevicesAcrossAccounts(accountId: string): Promise<readonly SharedDeviceLink[]> {
    await this.load();
    const out: SharedDeviceLink[] = [];
    for (const device of this.devicesByAccount.get(accountId) ?? []) {
      const nCards = this.cardsOnProfile.get(device) ?? 0;
      // 'generic' profiles are dropped rather than returned as weak evidence.
      // They are not weak, they are meaningless: one of them covers 1,013 cards.
      if (strengthFor(device, nCards) === 'generic') continue;
      const accounts = this.accountsByDevice.get(device);
      if (!accounts || accounts.size < 2) continue;
      for (const link of this.sharedLinks.get(device) ?? []) {
        if (link.otherAccountId !== accountId) out.push(link);
      }
    }
    const rank: Record<DeviceLinkStrength, number> = { strong: 0, ring: 1, moderate: 2, generic: 3 };
    return out
      .sort((a, b) => rank[a.strength] - rank[b.strength] || a.nCardsOnProfile - b.nCardsOnProfile)
      .slice(0, MAX_SHARED_LINKS);
  }

  /**
   * The accounts active on a device profile within `days` of a timestamp. Policy
   * R6 turns on several cards showing fraud from one origin "in one window", so
   * the cohort matters more than the lifetime card count: 51 cardholders on one
   * phone build across a month is a ring, the same number across six months is
   * a popular handset.
   */
  async getDeviceCohort(
    deviceProfile: string,
    aroundTs: string,
    days: number,
  ): Promise<readonly string[]> {
    await this.load();
    const links = this.sharedLinks.get(deviceProfile) ?? [];
    const centre = Date.parse(aroundTs.replace(' ', 'T') + 'Z');
    if (Number.isNaN(centre)) return links.map((l) => l.otherAccountId);
    const windowMs = days * 86400 * 1000;
    const out: string[] = [];
    for (const link of links) {
      const first = Date.parse(link.firstSeen.replace(' ', 'T') + 'Z');
      const last = Date.parse(link.lastSeen.replace(' ', 'T') + 'Z');
      if (Number.isNaN(first) || Number.isNaN(last)) continue;
      // Overlap between [first,last] and the window around the alert.
      if (last >= centre - windowMs && first <= centre + windowMs) out.push(link.otherAccountId);
    }
    return [...new Set(out)];
  }

  async findLinkedFraudHistory(accountId: string): Promise<LinkedFraud> {
    await this.load();
    const isFraud = (c: ClosedCase): boolean => c.outcome === 'confirmed_fraud';
    const direct = (this.casesByAccount.get(accountId) ?? []).filter(isFraud);
    const seen = new Set(direct.map((c) => c.caseId));
    const viaSharedDevice: ClosedCase[] = [];
    for (const link of await this.findSharedDevicesAcrossAccounts(accountId)) {
      for (const c of this.casesByAccount.get(link.otherAccountId) ?? []) {
        if (isFraud(c) && !seen.has(c.caseId)) {
          seen.add(c.caseId);
          viaSharedDevice.push(c);
        }
      }
    }
    return { direct, viaSharedDevice };
  }

  async findSimilarClosedCases(
    accountId: string,
    pattern: string,
    region: string,
    topK: number,
  ): Promise<readonly SimilarCase[]> {
    await this.load();
    const scored = new Map<string, { c: ClosedCase; score: number; basis: Set<string> }>();
    // Each basis counts once per case. Scoring per matching link instead let one
    // case accumulate a score in the dozens just because an account shared a
    // common browser string with many others.
    const bump = (c: ClosedCase, points: number, why: string): void => {
      let entry = scored.get(c.caseId);
      if (!entry) {
        entry = { c, score: 0, basis: new Set<string>() };
        scored.set(c.caseId, entry);
      }
      if (entry.basis.has(why)) return;
      entry.basis.add(why);
      entry.score += points;
    };

    // A shared identifying device is the strongest structural link.
    for (const link of await this.findSharedDevicesAcrossAccounts(accountId)) {
      const points = link.strength === 'strong' ? 3 : 2;
      for (const c of this.casesByAccount.get(link.otherAccountId) ?? []) {
        bump(c, points, 'shared_device');
      }
    }
    if (pattern !== '' && pattern !== 'none') {
      for (const c of this.closedCases) if (c.pattern === pattern) bump(c, 1, 'same_pattern');
    }
    if (region !== '') {
      for (const c of this.closedCases) {
        if (c.txnIds.some((id) => this.txnById.get(id)?.addr1 === region)) {
          bump(c, 1, 'same_region');
        }
      }
    }
    // A confirmed outcome is worth more as memory than a cleared one, but both
    // are useful: half the exam cases are legitimate and cleared cases are how
    // the agent learns to say so.
    for (const entry of scored.values()) {
      if (entry.c.outcome === 'confirmed_fraud') entry.score += 1;
    }
    return [...scored.values()]
      .sort((a, b) => b.score - a.score || (a.c.caseId < b.c.caseId ? -1 : 1))
      .slice(0, topK)
      .map(({ c, score, basis }) => ({ ...c, score, basis: [...basis] }));
  }
}
