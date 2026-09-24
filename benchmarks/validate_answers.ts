// Validates cases/*.json against the Answer Format in
// data/HHGOA_IEEE/README.md. Missing or malformed fields score zero for that
// part of a case, so this runs before submission and fails loudly.
//
// It checks structure, the fixed vocabularies, the internal consistency rules
// the README calls out, and that every id actually exists in the dataset.
//
// Usage: npm run validate

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalEvidenceSource } from '../src/tools/local-evidence-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CASES_DIR = path.join(REPO_ROOT, 'cases');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');

const PATTERNS = new Set([
  'card_testing', 'card_not_present_fraud', 'card_not_present_new_device',
  'out_of_region_use', 'account_takeover', 'undocumented', 'none',
]);
const STATUSES = new Set(['open', 'closed_fraud', 'closed_legitimate', 'escalated']);
const VERDICTS = new Set(['fraud', 'legitimate', 'uncertain']);
const ROUTES = new Set(['auto', 'L1', 'L2']);
const SOURCES = new Set(['graph', 'document', 'customer', 'external']);
const REQUEST_TYPES = new Set(['customer_validation', 'step_up_auth', 'analyst_info']);
const TOP_LEVEL = [
  'case_id', 'case', 'evidence_requests', 'next_best_actions', 'sar',
  'stop_reason', 'tool_calls', 'tokens', 'latency_s',
];
const CASE_FIELDS = [
  'status', 'verdict', 'fraud_probability', 'pattern', 'pattern_description',
  'affected_txn_ids', 'first_suspicious_txn_id', 'connected_card_ids',
  'connected_device_profiles', 'exposure_usd', 'evidence', 'similar_prior_cases',
  'summary', 'written_to_graph', 'graph_case_id',
];

const problems: string[] = [];
function fail(caseId: string, msg: string): void {
  problems.push(`${caseId}: ${msg}`);
}

async function main(): Promise<void> {
  const permissions = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'permissions.json'), 'utf8')) as {
    actions: Record<string, { route: string }>;
  };
  const validActions = new Set(Object.keys(permissions.actions));
  const policyRules = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'policy_rules.json'), 'utf8')) as {
    rules: Record<string, unknown>;
  };
  const ruleIds = Object.keys(policyRules.rules);
  const ruleCited = new RegExp(`\\b(${ruleIds.join('|')})\\b`);

  const evidence = new LocalEvidenceSource();
  const pack = await evidence.getCasePack();
  const expected = new Set(pack.map((p) => p.caseId));
  const validCaseIds = new Set<string>();
  for (const p of pack) validCaseIds.add(p.caseId);

  if (!existsSync(CASES_DIR)) {
    console.error(`cases/ does not exist. Run npm run benchmark first.`);
    process.exitCode = 1;
    return;
  }
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json'));
  console.log(`validating ${files.length} answer files against the dataset Answer Format\n`);

  for (const id of expected) {
    if (!files.includes(`${id}.json`)) fail(id, 'answer file is missing');
  }

  for (const file of files) {
    const raw = readFileSync(path.join(CASES_DIR, file), 'utf8');
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      problems.push(`${file}: is not valid JSON`);
      continue;
    }
    const id = String(a['case_id'] ?? file);

    for (const f of TOP_LEVEL) if (!(f in a)) fail(id, `missing top-level field "${f}"`);
    for (const k of Object.keys(a)) if (!TOP_LEVEL.includes(k)) fail(id, `unexpected top-level field "${k}"`);
    if (!expected.has(id)) fail(id, 'case_id is not one of the 20 exam cases');

    const c = a['case'] as Record<string, unknown> | undefined;
    if (!c) {
      fail(id, 'case object is missing');
      continue;
    }
    for (const f of CASE_FIELDS) if (!(f in c)) fail(id, `case is missing "${f}"`);

    const verdict = String(c['verdict']);
    const pattern = String(c['pattern']);
    const status = String(c['status']);
    if (!VERDICTS.has(verdict)) fail(id, `verdict "${verdict}" is not allowed`);
    if (!PATTERNS.has(pattern)) fail(id, `pattern "${pattern}" is not one of the seven allowed values`);
    if (!STATUSES.has(status)) fail(id, `status "${status}" is not allowed`);

    const prob = Number(c['fraud_probability']);
    if (!(prob >= 0 && prob <= 1)) fail(id, `fraud_probability ${prob} is outside 0 to 1`);

    if (pattern === 'undocumented' && String(c['pattern_description']).trim() === '') {
      fail(id, 'pattern is undocumented but pattern_description is empty');
    }
    if (pattern !== 'undocumented' && String(c['pattern_description']) !== '') {
      fail(id, 'pattern_description must be "" unless the pattern is undocumented');
    }

    const affected = (c['affected_txn_ids'] ?? []) as string[];
    const exposure = Number(c['exposure_usd']);
    const sar = a['sar'] as Record<string, unknown>;

    // The README states these three explicitly for a legitimate verdict.
    if (verdict === 'legitimate') {
      if (affected.length !== 0) fail(id, 'verdict is legitimate but affected_txn_ids is not empty');
      if (exposure !== 0) fail(id, `verdict is legitimate but exposure_usd is ${exposure}`);
      if (sar['file'] === true) fail(id, 'verdict is legitimate but sar.file is true');
    }

    // Every id must exist in the dataset. Made-up ids score zero.
    for (const txnId of affected) {
      if (!(await evidence.txnExists(txnId))) fail(id, `affected_txn_ids contains ${txnId}, which is not in the dataset`);
    }
    const firstTxn = String(c['first_suspicious_txn_id']);
    if (firstTxn !== '' && !(await evidence.txnExists(firstTxn))) {
      fail(id, `first_suspicious_txn_id ${firstTxn} is not in the dataset`);
    }

    const evidenceList = (c['evidence'] ?? []) as { claim?: string; source?: string; ref?: string; entity_ids?: unknown }[];
    if (evidenceList.length === 0) fail(id, 'evidence list is empty');
    for (const e of evidenceList) {
      if (!e.source || !SOURCES.has(e.source)) fail(id, `evidence source "${String(e.source)}" is not allowed`);
      if (!e.claim || e.claim.trim() === '') fail(id, 'an evidence item has an empty claim');
      if (!e.ref || e.ref.trim() === '') fail(id, 'an evidence item has an empty ref');
      if (!Array.isArray(e.entity_ids)) fail(id, 'an evidence item has no entity_ids array');
    }

    // Actions: identifiers, routes, and a policy rule citation.
    const nba = a['next_best_actions'] as Record<string, unknown>;
    for (const phase of ['initial', 'final'] as const) {
      const list = (nba[phase] ?? []) as { action?: string; route?: string; reason?: string }[];
      if (!Array.isArray(list)) {
        fail(id, `next_best_actions.${phase} is not a list`);
        continue;
      }
      if (list.length === 0) fail(id, `next_best_actions.${phase} is empty`);
      for (const x of list) {
        if (!x.action || !validActions.has(x.action)) {
          fail(id, `${phase} action "${String(x.action)}" is not one of the 14 policy identifiers`);
        }
        if (!x.route || !ROUTES.has(x.route)) fail(id, `${phase} action ${String(x.action)} has route "${String(x.route)}"`);
        if (!x.reason || !ruleCited.test(x.reason)) {
          fail(id, `${phase} action ${String(x.action)} cites no policy rule id in its reason`);
        }
      }
    }
    if (typeof nba['what_changed'] !== 'string' || String(nba['what_changed']).trim() === '') {
      fail(id, 'next_best_actions.what_changed is empty');
    }
    const requests = (a['evidence_requests'] ?? []) as { type?: string; asked_after_step?: unknown; assumed_response?: string }[];
    for (const r of requests) {
      if (!r.type || !REQUEST_TYPES.has(r.type)) fail(id, `evidence request type "${String(r.type)}" is not allowed`);
      if (typeof r.asked_after_step !== 'number') fail(id, 'evidence request has no numeric asked_after_step');
      if (!r.assumed_response || r.assumed_response.trim() === '') fail(id, 'evidence request has no assumed_response');
    }
    if (requests.length === 0 && String(nba['what_changed']) !== 'nothing') {
      fail(id, 'nothing was requested but what_changed is not "nothing"');
    }

    // SAR consistency with the final actions, which the README requires.
    const finalActions = ((nba['final'] ?? []) as { action?: string }[]).map((x) => x.action);
    const fileReport = finalActions.includes('FILE_REPORT');
    if (sar['file'] === true && !fileReport) fail(id, 'sar.file is true but FILE_REPORT is not in the final actions');
    if (sar['file'] !== true && fileReport) fail(id, 'FILE_REPORT is recommended but sar.file is false');
    if (!sar['reason'] || String(sar['reason']).trim() === '') fail(id, 'sar.reason is empty');
    if (sar['file'] === true) {
      const narrative = String(sar['narrative']);
      const sentences = narrative.split(/[.!?]\s/).filter((s) => s.trim() !== '').length;
      if (sentences < 6) fail(id, `sar.narrative has ${sentences} sentences, the README asks for six to twelve`);
      if (((sar['subjects'] ?? []) as string[]).length === 0) fail(id, 'sar.file is true but subjects is empty');
      if (((sar['activity_dates'] ?? []) as string[]).length !== 2) fail(id, 'sar.activity_dates must hold two dates');
    } else {
      if (String(sar['narrative']) !== '') fail(id, 'sar.file is false but narrative is not ""');
      if (((sar['subjects'] ?? []) as string[]).length !== 0) fail(id, 'sar.file is false but subjects is not empty');
      if (Number(sar['total_amount_usd']) !== 0) fail(id, 'sar.file is false but total_amount_usd is not 0');
      if (((sar['activity_dates'] ?? []) as string[]).length !== 0) fail(id, 'sar.file is false but activity_dates is not empty');
    }

    if (String(a['stop_reason']).trim() === '') fail(id, 'stop_reason is empty');
    if (String(c['summary']).trim() === '') fail(id, 'summary is empty');
    for (const f of ['tool_calls', 'tokens', 'latency_s'] as const) {
      if (typeof a[f] !== 'number') fail(id, `${f} is not a number`);
    }
    if (Number(a['tool_calls']) <= 0) fail(id, 'tool_calls is 0, so no evidence was gathered');

    // Similar prior cases must be real closed-case ids.
    for (const cc of (c['similar_prior_cases'] ?? []) as string[]) {
      if (!/^CC-\d{4}$/.test(cc)) fail(id, `similar_prior_cases contains "${cc}", which is not a closed-case id`);
    }
  }

  if (problems.length === 0) {
    console.log(`PASS: ${files.length} answer files are valid and internally consistent.`);
    return;
  }
  console.log(`FAIL: ${problems.length} problems\n`);
  for (const p of problems.slice(0, 60)) console.log(`  ${p}`);
  if (problems.length > 60) console.log(`  ... and ${problems.length - 60} more`);
  process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
