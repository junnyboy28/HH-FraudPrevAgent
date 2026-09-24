// Turns data/HHGOA_IEEE into load-ready CSVs, one per vertex and edge type,
// under graph/load/prepared/<mode>/. The GSQL loading job in load_jobs.gsql
// reads those files, so TigerGraph never parses the raw dataset.
//
// Three things cannot be read straight off the raw files and are computed here:
//   1. card_id (C01234-K1). transactions.csv has no card_id column.
//   2. NEXT_TXN edges, which need transactions ordered by ts within a card.
//   3. SHARED_BY edges, which need device profiles joined back to accounts.
//
// Usage:
//   npm run prep:sample     first 1,000 transactions, for fast iteration
//   npm run prep:full       all 590,742 transactions
//
// Both modes write counts.json next to the CSVs. graph/load/README.md lists the
// numbers a full load should produce.

import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data', 'HHGOA_IEEE');

interface Options {
  readonly mode: 'sample' | 'full';
  readonly limit: number | null;
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): Options {
  const mode = argv.includes('--full') ? 'full' : 'sample';
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = mode === 'full' ? null : Number(limitArg?.split('=')[1] ?? 1000);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, got ${String(limitArg)}`);
  }
  return { mode, limit, outDir: path.join(HERE, 'prepared', mode) };
}

// transactions.csv and identity.csv contain no quoted fields (checked across
// both files in full). closed_cases_history.csv does, so it goes through the
// quote-aware parser.
function splitPlain(line: string): string[] {
  return line.split(',');
}

function splitQuoted(line: string): string[] {
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

// The loading job sets QUOTE="double", so every field written here is quoted
// and embedded quotes are doubled. Carriage returns and newlines are flattened
// to spaces: the loader splits records on newline, and a stray CR would
// otherwise ride along inside analyst_notes and into case summaries.
function csvCell(value: string): string {
  return `"${value.replace(/[\r\n]+/g, ' ').trimEnd().replace(/"/g, '""')}"`;
}

function csvRow(values: readonly (string | number | boolean)[]): string {
  return values.map((v) => csvCell(typeof v === 'string' ? v : String(v))).join(',') + '\n';
}

// Writes in fixed-size chunks rather than holding the whole file in memory: a
// full run emits about 1.8 million rows across all the files.
const CHUNK_ROWS = 50_000;

class CsvWriter {
  private parts: string[] = [];
  private rows = 0;

  constructor(
    private readonly file: string,
    header: readonly string[],
  ) {
    writeFileSync(this.file, header.join(',') + '\n', 'utf8');
  }

  write(values: readonly (string | number | boolean)[]): void {
    this.parts.push(csvRow(values));
    this.rows++;
    if (this.parts.length >= CHUNK_ROWS) this.flush();
  }

  get count(): number {
    return this.rows;
  }

  flush(): void {
    if (this.parts.length === 0) return;
    appendFileSync(this.file, this.parts.join(''), 'utf8');
    this.parts = [];
  }
}

async function eachLine(file: string, onLine: (line: string, index: number) => boolean | void): Promise<void> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    if (line === '') continue;
    const keepGoing = onLine(line, i++);
    if (keepGoing === false) break;
  }
  rl.close();
}

// Missing numeric columns are written as -1. dist1 and dist2 are distances and
// are never negative in the source, so -1 is unambiguous there. No other
// numeric column gets a sentinel: the unnamed feature groups are not loaded.
function num(value: string | undefined): string {
  return value === undefined || value === '' ? '-1' : value;
}

function str(value: string | undefined): string {
  return value ?? '';
}

/** Reads a column by name from a split row, tolerating an absent column. */
function pick(row: readonly string[], cols: Map<string, number>, name: string): string {
  const i = cols.get(name);
  return i === undefined ? '' : str(row[i]);
}

/** "DeviceInfo | OS | browser | screen", the exact form the answer format uses. */
function deviceProfileId(deviceInfo: string, os: string, browser: string, screen: string): string {
  return [deviceInfo, os, browser, screen].join(' | ');
}

interface TxnRef {
  readonly txnId: string;
  readonly cardId: string;
  readonly dt: number;
}

interface Agg {
  n: number;
  first: string;
  last: string;
}

function bump(m: Map<string, Agg>, key: string, ts: string): void {
  let a = m.get(key);
  if (!a) {
    a = { n: 0, first: ts, last: ts };
    m.set(key, a);
  }
  a.n++;
  if (ts < a.first) a.first = ts;
  if (ts > a.last) a.last = ts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  for (const f of ['transactions.csv', 'identity.csv', 'closed_cases_history.csv']) {
    if (!existsSync(path.join(DATA_DIR, f))) {
      throw new Error(`Missing ${f} in ${DATA_DIR}. The dataset is not checked in; see README.md.`);
    }
  }
  mkdirSync(opts.outDir, { recursive: true });
  console.log(`mode=${opts.mode}${opts.limit === null ? '' : ` limit=${opts.limit}`}`);
  console.log(`out=${opts.outDir}`);

  const txnFile = path.join(DATA_DIR, 'transactions.csv');

  // --- pass 1: column positions, loaded transaction ids, card6 per account ---
  // This pass always reads the whole file, even in sample mode. A card's -KN
  // index is its position among ALL of that customer's card6 values, so a
  // slice that happens to contain only one of a customer's two cards would
  // otherwise number it K1 and disagree with the case pack.
  const col = new Map<string, number>();
  const card6ByAccount = new Map<string, Set<string>>();
  const loadedTxnIds = new Set<string>();

  await eachLine(txnFile, (line, i) => {
    const f = splitPlain(line);
    if (i === 0) {
      f.forEach((h, idx) => col.set(h, idx));
      return;
    }
    const account = pick(f, col, 'customer_id');
    const card6 = pick(f, col, 'card6');
    if (opts.limit === null || i <= opts.limit) loadedTxnIds.add(pick(f, col, 'TransactionID'));
    let set = card6ByAccount.get(account);
    if (!set) {
      set = new Set<string>();
      card6ByAccount.set(account, set);
    }
    set.add(card6);
    return;
  });

  const idxOf = (name: string): number => {
    const i = col.get(name);
    if (i === undefined) throw new Error(`transactions.csv is missing the ${name} column`);
    return i;
  };
  const iTxn = idxOf('TransactionID');
  const iDt = idxOf('TransactionDT');
  const iAmt = idxOf('TransactionAmt');
  const iPcd = idxOf('ProductCD');
  const iAcc = idxOf('customer_id');
  const iTs = idxOf('ts');
  const iChan = idxOf('channel');
  const iRisk = idxOf('risk_score');
  const iCard1 = idxOf('card1');
  const iCard2 = idxOf('card2');
  const iCard3 = idxOf('card3');
  const iCard4 = idxOf('card4');
  const iCard5 = idxOf('card5');
  const iCard6 = idxOf('card6');
  const iAddr1 = idxOf('addr1');
  const iAddr2 = idxOf('addr2');
  const iDist1 = idxOf('dist1');
  const iDist2 = idxOf('dist2');
  const iPEmail = idxOf('P_emaildomain');
  const iREmail = idxOf('R_emaildomain');
  const iM = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => idxOf(`M${n}`));

  // card_id = <customer_id>-K<n>, where n is the 1-based position of the row's
  // card6 value among that customer's distinct card6 values sorted ascending
  // (the empty value sorts first). This rule reproduces every card_id in
  // closed_cases_history.csv (14,955 of 14,955 transaction labels) and in
  // case_pack.csv (20 of 20). See "How card_id is derived" in the README.
  const cardIndex = new Map<string, string>();
  const cardMeta = new Map<string, { account: string; card6: string; kIndex: number }>();
  for (const [account, values] of card6ByAccount) {
    const sorted = [...values].sort();
    sorted.forEach((v, idx) => {
      const cardId = `${account}-K${idx + 1}`;
      cardIndex.set(`${account}\u0000${v}`, cardId);
      cardMeta.set(cardId, { account, card6: v, kIndex: idx + 1 });
    });
  }

  // --- pass 2: identity.csv, restricted to the transactions being loaded ---
  const wDevEdge = new CsvWriter(path.join(opts.outDir, 'e_used_device.csv'), [
    'txn_id', 'device_profile', 'device_type',
    'id_12', 'id_13', 'id_14', 'id_15', 'id_16', 'id_17', 'id_18', 'id_19', 'id_20',
    'id_21', 'id_22', 'id_23', 'id_24', 'id_25', 'id_26', 'id_27', 'id_28', 'id_29',
    'id_30', 'id_31', 'id_32', 'id_33', 'id_34', 'id_35', 'id_36', 'id_37', 'id_38',
  ]);

  interface DeviceAgg {
    info: string;
    os: string;
    browser: string;
    screen: string;
    type: string;
    n: number;
    cards: Set<string>;
  }
  const devices = new Map<string, DeviceAgg>();
  const identityTxns: { txnId: string; profile: string }[] = [];
  const idCol = new Map<string, number>();

  await eachLine(path.join(DATA_DIR, 'identity.csv'), (line, i) => {
    const f = splitPlain(line);
    if (i === 0) {
      f.forEach((h, idx) => idCol.set(h, idx));
      return;
    }
    const txnId = pick(f, idCol, 'TransactionID');
    // Only identity rows for loaded transactions are kept, so USED_DEVICE never
    // points at a transaction that is absent from the graph.
    if (!loadedTxnIds.has(txnId)) return;
    const info = pick(f, idCol, 'DeviceInfo');
    const os = pick(f, idCol, 'id_30');
    const browser = pick(f, idCol, 'id_31');
    const screen = pick(f, idCol, 'id_33');
    const deviceType = pick(f, idCol, 'DeviceType');
    const profile = deviceProfileId(info, os, browser, screen);

    const idVals: string[] = [];
    for (let n = 12; n <= 38; n++) idVals.push(pick(f, idCol, `id_${n}`));
    wDevEdge.write([txnId, profile, deviceType, ...idVals]);

    let d = devices.get(profile);
    if (!d) {
      d = { info, os, browser, screen, type: deviceType, n: 0, cards: new Set<string>() };
      devices.set(profile, d);
    }
    d.n++;
    identityTxns.push({ txnId, profile });
    return;
  });
  const identityTxnIds = new Set(identityTxns.map((r) => r.txnId));
  console.log(`identity rows kept: ${identityTxns.length}, device profiles: ${devices.size}`);

  // --- pass 3: transaction rows, their edges, and the vertex aggregates ---
  const wTxn = new CsvWriter(path.join(opts.outDir, 'transactions.csv'), [
    'txn_id', 'transaction_dt', 'amount', 'product_cd', 'channel', 'risk_score', 'ts',
    'account_id', 'card_id', 'card1', 'card2', 'card3', 'card4', 'card5', 'card6',
    'addr1', 'addr2', 'dist1', 'dist2', 'p_emaildomain', 'r_emaildomain',
    'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'has_identity',
  ]);
  const wMade = new CsvWriter(path.join(opts.outDir, 'e_made.csv'), ['card_id', 'txn_id']);
  const wPurchEmail = new CsvWriter(path.join(opts.outDir, 'e_purchaser_email.csv'), ['txn_id', 'domain']);
  const wRecipEmail = new CsvWriter(path.join(opts.outDir, 'e_recipient_email.csv'), ['txn_id', 'domain']);
  const wBilled = new CsvWriter(path.join(opts.outDir, 'e_billed_in.csv'), ['txn_id', 'region_code']);

  const accountAgg = new Map<string, Agg>();
  const cardAgg = new Map<string, Agg>();
  const emailAgg = new Map<string, number>();
  const regionAgg = new Map<string, { country: string; n: number; cards: Set<string> }>();
  const card1ByAccount = new Map<string, string>();
  const networkByCard = new Map<string, string>();
  const txnRefs: TxnRef[] = [];
  const accountOfTxn = new Map<string, string>();
  const cardOfTxn = new Map<string, string>();
  const tsOfTxn = new Map<string, string>();

  await eachLine(txnFile, (line, i) => {
    if (i === 0) return;
    if (opts.limit !== null && i > opts.limit) return false;
    const f = splitPlain(line);
    const txnId = str(f[iTxn]);
    const account = str(f[iAcc]);
    const card6 = str(f[iCard6]);
    const cardId = cardIndex.get(`${account}\u0000${card6}`);
    if (cardId === undefined) throw new Error(`No card_id derived for transaction ${txnId}`);
    const ts = str(f[iTs]);
    const addr1 = str(f[iAddr1]);
    const addr2 = str(f[iAddr2]);
    const pEmail = str(f[iPEmail]);
    const rEmail = str(f[iREmail]);
    const hasIdentity = identityTxnIds.has(txnId);

    wTxn.write([
      txnId, num(f[iDt]), num(f[iAmt]), str(f[iPcd]), str(f[iChan]), num(f[iRisk]), ts,
      account, cardId,
      str(f[iCard1]), str(f[iCard2]), str(f[iCard3]), str(f[iCard4]), str(f[iCard5]), card6,
      addr1, addr2, num(f[iDist1]), num(f[iDist2]), pEmail, rEmail,
      ...iM.map((idx) => str(f[idx])),
      hasIdentity,
    ]);
    wMade.write([cardId, txnId]);

    if (pEmail !== '') {
      wPurchEmail.write([txnId, pEmail]);
      emailAgg.set(pEmail, (emailAgg.get(pEmail) ?? 0) + 1);
    }
    if (rEmail !== '') {
      wRecipEmail.write([txnId, rEmail]);
      emailAgg.set(rEmail, (emailAgg.get(rEmail) ?? 0) + 1);
    }
    if (addr1 !== '') {
      wBilled.write([txnId, addr1]);
      let r = regionAgg.get(addr1);
      if (!r) {
        r = { country: addr2, n: 0, cards: new Set<string>() };
        regionAgg.set(addr1, r);
      }
      r.n++;
      r.cards.add(cardId);
    }

    bump(accountAgg, account, ts);
    bump(cardAgg, cardId, ts);
    if (!card1ByAccount.has(account)) card1ByAccount.set(account, str(f[iCard1]));
    const network = str(f[iCard4]);
    if (network !== '' && !networkByCard.has(cardId)) networkByCard.set(cardId, network);

    txnRefs.push({ txnId, cardId, dt: Number(str(f[iDt]) || '0') });
    accountOfTxn.set(txnId, account);
    cardOfTxn.set(txnId, cardId);
    tsOfTxn.set(txnId, ts);
    return;
  });
  console.log(`transactions: ${wTxn.count}`);

  // --- SHARED_BY and Device.n_cards, from the identity rows kept above ---
  const sharedBy = new Map<string, Agg>();
  for (const { txnId, profile } of identityTxns) {
    const account = accountOfTxn.get(txnId);
    const cardId = cardOfTxn.get(txnId);
    const ts = tsOfTxn.get(txnId);
    if (account === undefined || cardId === undefined || ts === undefined) continue;
    bump(sharedBy, `${profile}\u0000${account}`, ts);
    devices.get(profile)?.cards.add(cardId);
  }

  // --- NEXT_TXN: consecutive transactions on one card, ordered by ts ---
  const byCard = new Map<string, TxnRef[]>();
  for (const r of txnRefs) {
    let list = byCard.get(r.cardId);
    if (!list) {
      list = [];
      byCard.set(r.cardId, list);
    }
    list.push(r);
  }
  const wNext = new CsvWriter(path.join(opts.outDir, 'e_next_txn.csv'), ['from_txn_id', 'to_txn_id', 'gap_seconds']);
  for (const [, list] of byCard) {
    list.sort((a, b) => a.dt - b.dt || (a.txnId < b.txnId ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev === undefined || cur === undefined) continue;
      wNext.write([prev.txnId, cur.txnId, Math.max(0, cur.dt - prev.dt)]);
    }
  }

  // --- vertex files ---
  const wAccount = new CsvWriter(path.join(opts.outDir, 'accounts.csv'), [
    'account_id', 'card1', 'n_cards', 'n_transactions', 'first_seen', 'last_seen',
  ]);
  // n_cards counts the cards actually present in this graph. In sample mode
  // that can be fewer than the customer holds in the full dataset.
  const loadedCardsPerAccount = new Map<string, number>();
  for (const cardId of cardAgg.keys()) {
    const meta = cardMeta.get(cardId);
    if (meta === undefined) continue;
    loadedCardsPerAccount.set(meta.account, (loadedCardsPerAccount.get(meta.account) ?? 0) + 1);
  }
  for (const [account, agg] of accountAgg) {
    wAccount.write([
      account, card1ByAccount.get(account) ?? '', loadedCardsPerAccount.get(account) ?? 0,
      agg.n, agg.first, agg.last,
    ]);
  }

  const wCard = new CsvWriter(path.join(opts.outDir, 'cards.csv'), [
    'card_id', 'account_id', 'card_type', 'network', 'k_index', 'n_transactions', 'first_seen', 'last_seen',
  ]);
  const wOwns = new CsvWriter(path.join(opts.outDir, 'e_owns.csv'), ['account_id', 'card_id']);
  for (const [cardId, agg] of cardAgg) {
    const meta = cardMeta.get(cardId);
    if (meta === undefined) continue;
    wCard.write([
      cardId, meta.account, meta.card6, networkByCard.get(cardId) ?? '', meta.kIndex,
      agg.n, agg.first, agg.last,
    ]);
    wOwns.write([meta.account, cardId]);
  }

  const wDevice = new CsvWriter(path.join(opts.outDir, 'devices.csv'), [
    'device_profile', 'device_info', 'os', 'browser', 'screen', 'device_type', 'n_transactions', 'n_cards',
  ]);
  for (const [profile, d] of devices) {
    wDevice.write([profile, d.info, d.os, d.browser, d.screen, d.type, d.n, d.cards.size]);
  }

  const wShared = new CsvWriter(path.join(opts.outDir, 'e_shared_by.csv'), [
    'device_profile', 'account_id', 'n_transactions', 'first_seen', 'last_seen',
  ]);
  for (const [key, s] of sharedBy) {
    const [profile, account] = key.split('\u0000');
    wShared.write([str(profile), str(account), s.n, s.first, s.last]);
  }

  const wEmail = new CsvWriter(path.join(opts.outDir, 'email_domains.csv'), ['domain', 'n_transactions']);
  for (const [domain, n] of emailAgg) wEmail.write([domain, n]);

  const wRegion = new CsvWriter(path.join(opts.outDir, 'billing_regions.csv'), [
    'region_code', 'country_code', 'n_transactions', 'n_cards',
  ]);
  for (const [code, r] of regionAgg) wRegion.write([code, r.country, r.n, r.cards.size]);

  // --- the five documented patterns, from the dataset README ---
  const wPattern = new CsvWriter(path.join(opts.outDir, 'fraud_patterns.csv'), [
    'pattern_id', 'name', 'description', 'policy_refs', 'documented',
  ]);
  const PATTERNS: readonly (readonly [string, string, string, string, boolean])[] = [
    ['card_testing', 'Card testing',
      'A stolen card number is checked before use: three or more tiny online authorizations, often under $5, then a larger purchase. Confirmed by the sequence itself.',
      'R5', true],
    ['card_not_present_fraud', 'Card-not-present fraud',
      'The number is used online without the card. Amounts and products that do not fit the cardholder history, often in a burst of two to four within 48 hours. One unusual online purchase on its own is ambiguous: verify.',
      'R1,R2,R3,R4', true],
    ['card_not_present_new_device', 'Card-not-present fraud from a new device',
      'Card-not-present fraud where the identity record marks the device as New for this account, sometimes behind a proxy. Stronger than card_not_present_fraud, still not proof.',
      'R1,R2,R3,R4', true],
    ['out_of_region_use', 'Out-of-region use',
      'Card-present purchases in a billing region the cardholder has no history in, while normal activity continues at home. Several days of purchases in one new region is a trip, not a clone.',
      'R2,R3', true],
    ['account_takeover', 'Account takeover',
      'Mixed-channel activity inconsistent with the cardholder, often with device and match-flag anomalies, pointing to stolen credentials rather than a stolen number.',
      'R2,R10', true],
    ['undocumented', 'Undocumented pattern',
      'Coordinated or repeated abuse that fits none of the five documented patterns. The agent describes what it found in its own words rather than forcing a fit.',
      'R9', false],
    ['none', 'No pattern',
      'No fraud pattern identified. Used by cleared closed cases and by cases the agent closes as legitimate.',
      '', false],
  ];
  for (const [id, name, description, refs, documented] of PATTERNS) {
    wPattern.write([id, name, description, refs, documented]);
  }

  // --- closed cases ---
  const wCase = new CsvWriter(path.join(opts.outDir, 'cases.csv'), [
    'case_id', 'source', 'account_id', 'card_id', 'opened_at', 'closed_at', 'outcome', 'pattern',
    'first_fraud_txn_id', 'n_txns', 'exposure_usd', 'report_filed', 'actions_taken', 'analyst_notes',
    'status', 'verdict', 'fraud_probability', 'summary',
  ]);
  const wInvolves = new CsvWriter(path.join(opts.outDir, 'e_involves.csv'), ['case_id', 'txn_id']);
  const wOnCard = new CsvWriter(path.join(opts.outDir, 'e_on_card.csv'), ['case_id', 'card_id']);
  const wConnected = new CsvWriter(path.join(opts.outDir, 'e_connected_to.csv'), ['case_id', 'card_id']);
  const wInvestigates = new CsvWriter(path.join(opts.outDir, 'e_investigates.csv'), ['case_id', 'account_id']);
  const wMatches = new CsvWriter(path.join(opts.outDir, 'e_matches_pattern.csv'), ['case_id', 'pattern_id']);

  // The dataset files use CRLF, so split on both forms rather than leaving a
  // stray carriage return at the end of the last field on every row.
  const ccLines = readFileSync(path.join(DATA_DIR, 'closed_cases_history.csv'), 'utf8').split(/\r?\n/);
  const cc = new Map<string, number>();
  splitQuoted(str(ccLines[0])).forEach((h, i) => cc.set(h.trim(), i));
  const ccIdx = (name: string): number => {
    const i = cc.get(name);
    if (i === undefined) throw new Error(`closed_cases_history.csv is missing the ${name} column`);
    return i;
  };
  let casesKept = 0;
  let casesSkipped = 0;
  for (const line of ccLines.slice(1)) {
    if (line.trim() === '') continue;
    const f = splitQuoted(line);
    const caseId = str(f[ccIdx('case_id')]);
    const txnIds = str(f[ccIdx('txn_ids')]).split('|').filter((t) => t !== '');
    const kept = txnIds.filter((t) => loadedTxnIds.has(t));
    // In sample mode a case with no transaction inside the slice is dropped
    // rather than loaded with edges pointing at absent transactions.
    if (opts.limit !== null && kept.length === 0) {
      casesSkipped++;
      continue;
    }
    const cardId = str(f[ccIdx('card_id')]);
    const accountId = str(f[ccIdx('customer_id')]);
    const pattern = str(f[ccIdx('pattern')]);
    wCase.write([
      caseId, 'closed_history', accountId, cardId,
      str(f[ccIdx('opened_at')]), str(f[ccIdx('closed_at')]),
      str(f[ccIdx('outcome')]), pattern, str(f[ccIdx('first_fraud_txn_id')]),
      str(f[ccIdx('n_txns')]), num(f[ccIdx('exposure_usd')]), str(f[ccIdx('report_filed')]),
      str(f[ccIdx('actions_taken')]), str(f[ccIdx('analyst_notes')]),
      '', '', '-1', '',
    ]);
    for (const t of kept) wInvolves.write([caseId, t]);
    wOnCard.write([caseId, cardId]);
    wInvestigates.write([caseId, accountId]);
    if (pattern !== '') wMatches.write([caseId, pattern]);
    for (const connected of str(f[ccIdx('connected_card_ids')]).split('|').filter((c) => c !== '')) {
      wConnected.write([caseId, connected]);
    }
    casesKept++;
  }

  for (const w of [
    wTxn, wMade, wPurchEmail, wRecipEmail, wBilled, wDevEdge, wNext, wShared,
    wAccount, wCard, wOwns, wDevice, wEmail, wRegion, wPattern,
    wCase, wInvolves, wOnCard, wConnected, wInvestigates, wMatches,
  ]) {
    w.flush();
  }

  // --- verify the derived card_id against the two places the dataset states it ---
  // closed_cases_history.csv gives (card_id, txn_ids) and case_pack.csv gives
  // (card_id, flagged_txn_id). Both are independent of how this script derives
  // card_id, so they are a real check and not a restatement of the rule.
  let checked = 0;
  let wrong = 0;
  const reportWrong: string[] = [];
  for (const line of ccLines.slice(1)) {
    if (line.trim() === '') continue;
    const f = splitQuoted(line);
    const expected = str(f[ccIdx('card_id')]);
    for (const t of str(f[ccIdx('txn_ids')]).split('|').filter((x) => x !== '')) {
      const got = cardOfTxn.get(t);
      if (got === undefined) continue; // outside this slice
      checked++;
      if (got !== expected && reportWrong.length < 5) reportWrong.push(`txn ${t}: derived ${got}, dataset ${expected}`);
      if (got !== expected) wrong++;
    }
  }
  const casePackFile = path.join(DATA_DIR, 'case_pack.csv');
  let packChecked = 0;
  let packWrong = 0;
  if (existsSync(casePackFile)) {
    const cpLines = readFileSync(casePackFile, 'utf8').split(/\r?\n/);
    const cp = new Map<string, number>();
    splitQuoted(str(cpLines[0])).forEach((h, i) => cp.set(h.trim(), i));
    const iCardId = cp.get('card_id');
    const iFlagged = cp.get('flagged_txn_id');
    if (iCardId !== undefined && iFlagged !== undefined) {
      for (const line of cpLines.slice(1)) {
        if (line.trim() === '') continue;
        const f = splitQuoted(line);
        const got = cardOfTxn.get(str(f[iFlagged]));
        if (got === undefined) continue; // outside this slice
        packChecked++;
        if (got !== str(f[iCardId])) {
          packWrong++;
          if (reportWrong.length < 5) reportWrong.push(`case pack txn ${str(f[iFlagged])}: derived ${got}, dataset ${str(f[iCardId])}`);
        }
      }
    }
  }
  const verified = wrong === 0 && packWrong === 0;
  console.log(
    `card_id check: ${checked - wrong}/${checked} closed-case labels, ` +
    `${packChecked - packWrong}/${packChecked} case-pack rows`,
  );
  if (!verified) {
    for (const r of reportWrong) console.error(`  ${r}`);
    throw new Error('Derived card_id disagrees with the dataset. Do not load this output.');
  }

  const counts = {
    mode: opts.mode,
    limit: opts.limit,
    generated_at: new Date().toISOString(),
    vertices: {
      Account: wAccount.count,
      Card: wCard.count,
      Transaction: wTxn.count,
      Device: wDevice.count,
      EmailDomain: wEmail.count,
      BillingRegion: wRegion.count,
      Case: wCase.count,
      FraudPattern: wPattern.count,
      PolicyDoc: 0,
    },
    edges: {
      OWNS: wOwns.count,
      MADE: wMade.count,
      USED_DEVICE: wDevEdge.count,
      PURCHASER_EMAIL: wPurchEmail.count,
      RECIPIENT_EMAIL: wRecipEmail.count,
      BILLED_IN: wBilled.count,
      NEXT_TXN: wNext.count,
      SHARED_BY: wShared.count,
      INVOLVES: wInvolves.count,
      ON_CARD: wOnCard.count,
      CONNECTED_TO: wConnected.count,
      INVESTIGATES: wInvestigates.count,
      MATCHES_PATTERN: wMatches.count,
      SIMILAR_TO: 0,
      CITES_POLICY: 0,
    },
    closed_cases_skipped_outside_slice: casesSkipped,
    card_id_check: {
      closed_case_labels: checked,
      closed_case_labels_matched: checked - wrong,
      case_pack_rows: packChecked,
      case_pack_rows_matched: packChecked - packWrong,
    },
  };
  writeFileSync(path.join(opts.outDir, 'counts.json'), JSON.stringify(counts, null, 2) + '\n', 'utf8');

  console.log(`closed cases: ${casesKept} kept, ${casesSkipped} skipped (no transaction in this slice)`);
  console.log(JSON.stringify(counts.vertices));
  console.log(JSON.stringify(counts.edges));
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
