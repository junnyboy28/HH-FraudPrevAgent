// Loads the prepared CSVs into TigerGraph over REST.
//
// The GSQL loader's HEADER="true" option applies to files the server reads, not
// to content posted to /restpp/ddl, so posted data must have its header line
// stripped and the job must declare HEADER="false". Large files are chunked
// because a single 132 MB POST is neither reliable nor resumable.
//
// Usage:
//   npx tsx scripts/load-tigergraph.ts sample
//   npx tsx scripts/load-tigergraph.ts full
//   npx tsx scripts/load-tigergraph.ts full --clear   (delete our vertices first)

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const GRAPH = 'FraudGraph';
const JOB = 'load_fraud_graph';
/** Rows per POST. Keeps each request well under a minute on a starter workspace. */
const CHUNK_ROWS = 40_000;

/** Vertices first, then edges, so edge endpoints already exist. */
const FILES: readonly (readonly [string, string])[] = [
  ['accounts.csv', 'f_accounts'],
  ['cards.csv', 'f_cards'],
  ['transactions.csv', 'f_transactions'],
  ['devices.csv', 'f_devices'],
  ['email_domains.csv', 'f_email_domains'],
  ['billing_regions.csv', 'f_billing_regions'],
  ['cases.csv', 'f_cases'],
  ['fraud_patterns.csv', 'f_fraud_patterns'],
  ['e_owns.csv', 'f_owns'],
  ['e_made.csv', 'f_made'],
  ['e_used_device.csv', 'f_used_device'],
  ['e_purchaser_email.csv', 'f_purchaser_email'],
  ['e_recipient_email.csv', 'f_recipient_email'],
  ['e_billed_in.csv', 'f_billed_in'],
  ['e_next_txn.csv', 'f_next_txn'],
  ['e_shared_by.csv', 'f_shared_by'],
  ['e_involves.csv', 'f_involves'],
  ['e_on_card.csv', 'f_on_card'],
  ['e_connected_to.csv', 'f_connected_to'],
  ['e_investigates.csv', 'f_investigates'],
  ['e_matches_pattern.csv', 'f_matches_pattern'],
];

const OUR_VERTEX_TYPES = [
  'Customer', 'PaymentCard', 'Transaction', 'DeviceProfile',
  'EmailDomain', 'BillingRegion', 'FraudCase', 'FraudPattern', 'PolicyDoc',
] as const;

function env(name: string): string {
  const raw = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('='));
    if (key.trim() === name) return line.slice(line.indexOf('=') + 1).trim();
  }
  throw new Error(`${name} is not set in .env`);
}

const HOST = env('TIGERGRAPH_HOST').replace(/\/$/, '');
const SECRET = env('TIGERGRAPH_TOKEN');

async function getToken(): Promise<string> {
  const res = await fetch(`${HOST}/gsql/v1/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, lifetime: '2592000' }),
  });
  const body = (await res.json()) as { token?: string; message?: string };
  if (!body.token) throw new Error(`Could not get a token: ${body.message ?? 'unknown error'}`);
  return body.token;
}

interface LoadStats {
  validLine: number;
  validObject: number;
  invalidAttribute: number;
  rejectLine: number;
}

function readStats(body: unknown): LoadStats {
  const out: LoadStats = { validLine: 0, validObject: 0, invalidAttribute: 0, rejectLine: 0 };
  const results = (body as { results?: unknown[] }).results ?? [];
  for (const r of results) {
    const ps = (r as { statistics?: { parsingStatistics?: Record<string, unknown> } }).statistics
      ?.parsingStatistics;
    if (!ps) continue;
    const fileLevel = ps['fileLevel'] as { validLine?: number; rejectLine?: number } | undefined;
    out.validLine += fileLevel?.validLine ?? 0;
    out.rejectLine += fileLevel?.rejectLine ?? 0;
    const objectLevel = ps['objectLevel'] as
      | { vertex?: { validObject?: number; invalidAttribute?: number }[]; edge?: { validObject?: number; invalidAttribute?: number }[] }
      | undefined;
    for (const group of [objectLevel?.vertex ?? [], objectLevel?.edge ?? []]) {
      for (const item of group) {
        out.validObject += item.validObject ?? 0;
        out.invalidAttribute += item.invalidAttribute ?? 0;
      }
    }
  }
  return out;
}

async function postChunk(token: string, filevar: string, rows: readonly string[]): Promise<LoadStats> {
  const res = await fetch(
    `${HOST}/restpp/ddl/${GRAPH}?tag=${JOB}&filename=${filevar}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
      body: rows.join('\n') + '\n',
    },
  );
  const body: unknown = await res.json();
  if ((body as { error?: boolean }).error === true) {
    throw new Error(`Load failed for ${filevar}: ${(body as { message?: string }).message ?? ''}`);
  }
  return readStats(body);
}

/** Streams a prepared CSV, drops its header line, and posts it in chunks. */
async function loadFile(token: string, dir: string, file: string, filevar: string): Promise<LoadStats> {
  const full = path.join(dir, file);
  const total: LoadStats = { validLine: 0, validObject: 0, invalidAttribute: 0, rejectLine: 0 };
  const rl = createInterface({ input: createReadStream(full, 'utf8'), crlfDelay: Infinity });
  let batch: string[] = [];
  let isHeader = true;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const s = await postChunk(token, filevar, batch);
    total.validLine += s.validLine;
    total.validObject += s.validObject;
    total.invalidAttribute += s.invalidAttribute;
    total.rejectLine += s.rejectLine;
    batch = [];
  };
  for await (const line of rl) {
    if (line === '') continue;
    if (isHeader) {
      isHeader = false;
      continue;
    }
    batch.push(line);
    if (batch.length >= CHUNK_ROWS) await flush();
  }
  await flush();
  return total;
}

async function clearOurVertices(token: string): Promise<void> {
  // Deletes only the vertex types this project owns. The workspace also carries
  // a pre-loaded demo schema, which is left untouched.
  for (const type of OUR_VERTEX_TYPES) {
    const res = await fetch(`${HOST}/restpp/graph/${GRAPH}/delete_by_type/vertices/${type}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { error?: boolean; results?: { deleted_vertices?: number }; message?: string };
    const n = body.results?.deleted_vertices ?? 0;
    console.log(`  cleared ${String(n).padStart(8)} ${type}${body.error === true ? ` (${body.message ?? ''})` : ''}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] === 'full' ? 'full' : 'sample';
  const doClear = process.argv.includes('--clear');
  const dir = path.join(REPO_ROOT, 'graph', 'load', 'prepared', mode);
  if (!existsSync(dir)) throw new Error(`No prepared files at ${dir}. Run npm run prep:${mode} first.`);

  const token = await getToken();
  console.log(`host  ${HOST}`);
  console.log(`graph ${GRAPH}, job ${JOB}, mode ${mode}`);

  if (doClear) {
    console.log('\nclearing this project\'s vertex types (the pre-loaded demo schema is left alone)');
    await clearOurVertices(token);
  }

  console.log('\nfile                      MB   lines   objects  badAttr  reject');
  console.log('------------------------ ---- ------- --------- -------- -------');
  const started = Date.now();
  for (const [file, filevar] of FILES) {
    const full = path.join(dir, file);
    if (!existsSync(full)) {
      console.log(`${file.padEnd(24)} MISSING, skipped`);
      continue;
    }
    const mb = statSync(full).size / 1e6;
    const s = await loadFile(token, dir, file, filevar);
    console.log(
      `${file.padEnd(24)} ${mb.toFixed(1).padStart(4)} ${String(s.validLine).padStart(7)} ` +
      `${String(s.validObject).padStart(9)} ${String(s.invalidAttribute).padStart(8)} ${String(s.rejectLine).padStart(7)}`,
    );
  }
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
