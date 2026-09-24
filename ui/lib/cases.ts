// Server-side access to the case records in cases/ and the approval records in
// config/approvals.json.
//
// The UI reads the same answer files that are submitted, so what the demo shows
// is exactly what is graded, with nothing re-derived for display.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Locally the repo's cases/ is read directly, so a benchmark re-run shows up
// immediately. A host that deploys only ui/ has no parent directory, so the
// vendored copy in ui/data (written by scripts/sync-data.mjs at build time) is
// the fallback.
const REPO_ROOT = path.resolve(process.cwd(), '..');
const VENDORED = path.join(process.cwd(), 'data');
const CASES_DIR = existsSync(path.join(REPO_ROOT, 'cases'))
  ? path.join(REPO_ROOT, 'cases')
  : path.join(VENDORED, 'cases');
const APPROVALS = existsSync(path.join(REPO_ROOT, 'config'))
  ? path.join(REPO_ROOT, 'config', 'approvals.json')
  : path.join(VENDORED, 'config', 'approvals.json');

/** True when this instance can write approval records (a writable filesystem). */
export function approvalsWritable(): boolean {
  return existsSync(path.dirname(APPROVALS));
}

export interface Action {
  readonly action: string;
  readonly route: 'auto' | 'L1' | 'L2';
  readonly reason: string;
}

export interface EvidenceItem {
  readonly claim: string;
  readonly source: 'graph' | 'document' | 'customer' | 'external';
  readonly ref: string;
  readonly entity_ids: readonly string[];
}

export interface AnswerFile {
  readonly case_id: string;
  readonly case: {
    readonly status: string;
    readonly verdict: 'fraud' | 'legitimate' | 'uncertain';
    readonly fraud_probability: number;
    readonly pattern: string;
    readonly pattern_description: string;
    readonly affected_txn_ids: readonly string[];
    readonly first_suspicious_txn_id: string;
    readonly connected_card_ids: readonly string[];
    readonly connected_device_profiles: readonly string[];
    readonly exposure_usd: number;
    readonly evidence: readonly EvidenceItem[];
    readonly similar_prior_cases: readonly string[];
    readonly summary: string;
    readonly written_to_graph: boolean;
    readonly graph_case_id: string;
  };
  readonly evidence_requests: readonly {
    readonly type: string;
    readonly asked_after_step: number;
    readonly assumed_response: string;
  }[];
  readonly next_best_actions: {
    readonly initial: readonly Action[];
    readonly final: readonly Action[];
    readonly what_changed: string;
  };
  readonly sar: {
    readonly file: boolean;
    readonly reason: string;
    readonly narrative: string;
    readonly subjects: readonly string[];
    readonly total_amount_usd: number;
    readonly activity_dates: readonly string[];
  };
  readonly stop_reason: string;
  readonly tool_calls: number;
  readonly tokens: number;
  readonly latency_s: number;
}

export function listCases(): readonly AnswerFile[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(CASES_DIR, f), 'utf8')) as AnswerFile);
}

export function getCase(caseId: string): AnswerFile | null {
  const file = path.join(CASES_DIR, `${caseId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as AnswerFile;
}

/** caseId -> action -> the approval record. */
type ApprovalStore = Record<string, Record<string, { decision: 'approved' | 'rejected'; at: string; route: string }>>;

function readApprovals(): ApprovalStore {
  if (!existsSync(APPROVALS)) return {};
  try {
    return JSON.parse(readFileSync(APPROVALS, 'utf8')) as ApprovalStore;
  } catch {
    return {};
  }
}

export function approvalsFor(caseId: string): Record<string, { decision: string; at: string }> {
  return readApprovals()[caseId] ?? {};
}

/**
 * Records a human decision on a gated action. An L1 or L2 action is never
 * executed without a record here, which is the point of the permission gate:
 * the agent recommends, a human decides.
 */
/** Writes an approval record. No-ops on a read-only host rather than throwing. */
export function recordApproval(
  caseId: string,
  action: string,
  route: string,
  decision: 'approved' | 'rejected',
): void {
  if (!approvalsWritable()) return;
  const store = readApprovals();
  store[caseId] ??= {};
  const entry = store[caseId];
  if (entry) entry[action] = { decision, at: new Date().toISOString(), route };
  writeFileSync(APPROVALS, JSON.stringify(store, null, 2) + '\n', 'utf8');
}
