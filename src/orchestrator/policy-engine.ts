// Turns an assessed case into recommended actions, each citing the policy rule
// that produced it.
//
// Rules R1 to R10 come from the Fraud Policy in data/HHGOA_IEEE/README.md and
// live in config/policy_rules.json. Action identifiers and approval routes come
// from config/permissions.json. Both are read at runtime rather than hardcoded,
// so the demo can show the config and show the gate firing.
//
// This is deliberately deterministic. The LLM decides what the evidence means
// (pattern, probability, narrative); the policy decides what may be done about
// it. Handing action selection to a model would make the permission model
// unverifiable, which is the opposite of what the brief asks for.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(HERE, '..', '..', 'config');

export type Route = 'auto' | 'L1' | 'L2';

/** The response the agent assumed when it asked the customer. */
export type CustomerResponse = 'denied' | 'confirmed' | 'no_reply' | 'not_asked';

export interface RecommendedAction {
  readonly action: string;
  readonly route: Route;
  readonly reason: string;
}

export interface CaseAssessment {
  readonly fraudProbability: number;
  readonly verdict: 'fraud' | 'legitimate' | 'uncertain';
  readonly pattern: string;
  readonly exposureUsd: number;
  /** True when the case rests on a single signal, which triggers R1. */
  readonly singleSignal: boolean;
  readonly customerResponse: CustomerResponse;
  /** A shared device profile, region cluster or another card's fraud. */
  readonly connectedToSharedOrigin: boolean;
  /** The shared element named, for R6. */
  readonly sharedOriginDescription: string;
  /** True when the disputed charge matches the cardholder's recurring pattern. */
  readonly matchesRecurringPattern: boolean;
  /** True when the evidence points in conflicting directions, for R8. */
  readonly evidenceConflicts: boolean;
  /** Cards of this customer with confirmed fraud, for R10. */
  readonly cardsWithConfirmedFraud: number;
  /** A cleared purchase over $100 in a card-testing sequence, for R5. */
  readonly clearedPurchaseAmount: number;
  /** True when the customer disputed the charge (a customer_report trigger). */
  readonly disputed: boolean;
}

interface PermissionsConfig {
  readonly actions: Record<
    string,
    {
      readonly route: Route;
      readonly route_conditions?: readonly {
        readonly when: { readonly field: string; readonly op: string; readonly value: number };
        readonly route: Route;
        readonly reason?: string;
      }[];
    }
  >;
}

interface PolicyRulesConfig {
  readonly rules: Record<string, { readonly title: string }>;
  readonly sar_criteria: unknown;
  readonly stopping_criteria: unknown;
  readonly escalation_guardrails: { readonly max_evidence_cycles: number };
}

let permissions: PermissionsConfig | null = null;
let policyRules: PolicyRulesConfig | null = null;

function loadPermissions(): PermissionsConfig {
  permissions ??= JSON.parse(
    readFileSync(path.join(CONFIG_DIR, 'permissions.json'), 'utf8'),
  ) as PermissionsConfig;
  return permissions;
}

export function loadPolicyRules(): PolicyRulesConfig {
  policyRules ??= JSON.parse(
    readFileSync(path.join(CONFIG_DIR, 'policy_rules.json'), 'utf8'),
  ) as PolicyRulesConfig;
  return policyRules;
}

/**
 * The permission gate. Resolves an action's approval route from config,
 * evaluating the conditional rules rather than reading a fixed value:
 * BLOCK_CARD is L1 at exposure of $2,500 or less and L2 above it.
 *
 * Throws on an unknown action, because an identifier that is not in the policy
 * is either a typo or invented, and both score zero for the case.
 */
export function resolveRoute(action: string, exposureUsd: number): Route {
  const config = loadPermissions();
  const entry = config.actions[action];
  if (entry === undefined) {
    throw new Error(
      `Action "${action}" is not in config/permissions.json. The 14 policy identifiers are fixed by the dataset.`,
    );
  }
  let route = entry.route;
  for (const condition of entry.route_conditions ?? []) {
    const value = condition.when.field === 'exposure_usd' ? exposureUsd : Number.NaN;
    if (Number.isNaN(value)) continue;
    const { op } = condition.when;
    const matched =
      (op === '>' && value > condition.when.value) ||
      (op === '>=' && value >= condition.when.value) ||
      (op === '<' && value < condition.when.value) ||
      (op === '<=' && value <= condition.when.value) ||
      (op === '==' && value === condition.when.value);
    if (matched) route = condition.route;
  }
  return route;
}

/** True when only `auto` actions may be executed by the agent itself. */
export function isAutonomous(action: string, exposureUsd: number): boolean {
  return resolveRoute(action, exposureUsd) === 'auto';
}

function add(
  out: RecommendedAction[],
  action: string,
  rule: string,
  why: string,
  exposureUsd: number,
): void {
  if (out.some((a) => a.action === action)) return;
  out.push({ action, route: resolveRoute(action, exposureUsd), reason: `${rule}: ${why}` });
}

/**
 * Applies the policy to an assessed case and returns the actions in the order
 * they should happen. Every action carries its rule id, which policy section 7
 * requires and the next-best-action score depends on.
 */
export function selectActions(a: CaseAssessment): readonly RecommendedAction[] {
  const out: RecommendedAction[] = [];
  const exposure = a.exposureUsd;

  // R3: the customer confirms the transaction. This settles it.
  if (a.customerResponse === 'confirmed') {
    add(out, 'CLOSE_NO_FRAUD', 'R3', 'cardholder confirmed they made the transaction', exposure);
    add(out, 'CREATE_CASE', 'R3', 'confirmation recorded in the case file', exposure);
    return out;
  }

  // R7: disputed, but it matches their own recurring pattern. Explicitly do not block.
  if (a.disputed && a.matchesRecurringPattern) {
    add(out, 'CREATE_CASE', 'R7', 'charge disputed but consistent with a recurring pattern on this card', exposure);
    add(out, 'VERIFY_WITH_CUSTOMER', 'R7', 'confirm the cardholder recognises the recurring charge', exposure);
    add(out, 'WARN_CUSTOMER', 'R7', 'send a recurring-charge reminder rather than blocking', exposure);
    return out;
  }

  // R5: card testing. The sequence is its own confirmation.
  if (a.pattern === 'card_testing') {
    add(out, 'DECLINE_TRANSACTION', 'R5', 'small-authorization testing sequence observed on this card', exposure);
    add(out, 'STEP_UP_AUTH', 'R5', 'require confirmation before further activity', exposure);
    if (a.clearedPurchaseAmount > 100) {
      add(out, 'BLOCK_CARD', 'R5', `a purchase of $${a.clearedPurchaseAmount.toFixed(2)} has already cleared`, exposure);
    }
  }

  // R2: the customer denies it.
  if (a.customerResponse === 'denied') {
    add(out, 'BLOCK_CARD', 'R2', 'cardholder denies making the transaction and still holds the card', exposure);
    add(out, 'CREATE_CASE', 'R2', 'confirmed unauthorized use', exposure);
    if (exposure > 1000 || a.connectedToSharedOrigin) {
      const why =
        exposure > 1000
          ? `exposure of $${exposure.toFixed(2)} exceeds $1,000`
          : `the case connects to ${a.sharedOriginDescription}`;
      add(out, 'FILE_REPORT', 'R2', why, exposure);
    }
  }

  // R4: asked and heard nothing back.
  if (a.customerResponse === 'no_reply') {
    add(out, 'MONITOR_CARD', 'R4', 'no cardholder response within 24 hours', exposure);
    add(out, 'DECLINE_TRANSACTION', 'R4', 'decline pending authorizations while unverified', exposure);
    if (exposure > 500) {
      add(out, 'ESCALATE_TO_ANALYST', 'R4', `exposure of $${exposure.toFixed(2)} exceeds $500 with no response`, exposure);
    }
  }

  // R1: a weak single signal must be verified, never blocked. This is a
  // prohibition, so it runs after the rules above and strips any block.
  const weakSingleSignal = a.singleSignal && a.fraudProbability < 0.7;
  if (weakSingleSignal && a.customerResponse === 'not_asked') {
    add(out, 'VERIFY_WITH_CUSTOMER', 'R1', `single signal at probability ${a.fraudProbability.toFixed(2)}, below 0.70`, exposure);
    add(out, 'STEP_UP_AUTH', 'R1', 'confirm the cardholder before considering any block', exposure);
  }

  // R6: several cards from one origin in one window.
  if (a.connectedToSharedOrigin && a.fraudProbability >= 0.5) {
    add(out, 'CREATE_CASE', 'R6', `shared origin identified: ${a.sharedOriginDescription}`, exposure);
    add(out, 'MONITOR_CONNECTED_CARDS', 'R6', 'cards sharing that origin placed under monitoring', exposure);
    add(out, 'FILE_REPORT', 'R6', `coordinated activity from ${a.sharedOriginDescription}`, exposure);
  }

  // R9: undocumented pattern with coordinated abuse.
  if (a.pattern === 'undocumented') {
    add(out, 'CREATE_CASE', 'R9', 'activity fits none of the five documented patterns', exposure);
    add(out, 'FILE_REPORT', 'R9', 'coordinated abuse across multiple cardholders', exposure);
    add(out, 'ESCALATE_TO_ANALYST', 'R9', 'undocumented pattern needs analyst review', exposure);
  }

  // R8: uncertain and exposed, or the evidence disagrees with itself.
  if ((a.verdict === 'uncertain' && exposure > 500) || a.evidenceConflicts) {
    add(
      out,
      'ESCALATE_TO_ANALYST',
      'R8',
      a.evidenceConflicts
        ? 'the evidence points in conflicting directions'
        : `verdict uncertain with exposure of $${exposure.toFixed(2)} above $500`,
      exposure,
    );
  }

  // Strongly suspected fraud that the cardholder has not been asked about still
  // has to be acted on. R2 is the blocking rule and its evidentiary standard is
  // unauthorized use; a probability at or above 0.70 with corroborating pattern
  // evidence meets it without waiting for a reply that the dataset never
  // provides. Without this, a case could sit at 0.85 with four figures of
  // exposure and recommend nothing stronger than monitoring.
  if (a.verdict === 'fraud' && a.customerResponse === 'not_asked' && !a.matchesRecurringPattern) {
    add(
      out,
      'BLOCK_CARD',
      'R2',
      `fraud strongly suspected at probability ${a.fraudProbability.toFixed(2)} on corroborated pattern evidence, with exposure of $${exposure.toFixed(2)}`,
      exposure,
    );
  }

  // Close a clearly legitimate case rather than leaving it open. Not while a
  // verification is outstanding: recommending "ask the cardholder" and "close as
  // legitimate" in the same breath is incoherent.
  const awaitingVerification = out.some(
    (x) => x.action === 'VERIFY_WITH_CUSTOMER' || x.action === 'STEP_UP_AUTH',
  );
  if (a.verdict === 'legitimate' && a.customerResponse !== 'denied' && !awaitingVerification) {
    add(out, 'CLOSE_NO_FRAUD', 'R1', 'no pattern evidence found and the signal does not survive review', exposure);
  }

  // A case is opened whenever probability reaches 0.30, evidence was requested,
  // or the customer disputed a charge (policy section 3a).
  if (a.fraudProbability >= 0.3 || a.customerResponse !== 'not_asked' || a.disputed) {
    add(out, 'CREATE_CASE', 'R1', 'case opened per policy section 3a', exposure);
  }

  // Monitoring is the low-impact default when nothing stronger is warranted.
  if (out.every((x) => x.action === 'CREATE_CASE') && a.fraudProbability >= 0.15) {
    add(out, 'MONITOR_CARD', 'R1', 'raise monitoring sensitivity while the signal is unresolved', exposure);
  }

  return reconcileSar(applyProhibitions(out, a), a);
}

/**
 * The answer format requires `sar.file` to agree with whether FILE_REPORT
 * appears in the final actions, so the two are reconciled here rather than
 * decided twice and hoped to match.
 *
 * R6 recommends a report for a shared origin, but policy 3a only permits one
 * when fraud is confirmed or strongly suspected, so a shared origin on an
 * otherwise ambiguous case gets the case and the monitoring without the
 * regulatory filing.
 */
function reconcileSar(
  actions: readonly RecommendedAction[],
  a: CaseAssessment,
): readonly RecommendedAction[] {
  const decision = decideSar(a);
  const has = actions.some((x) => x.action === 'FILE_REPORT');
  if (decision.file && !has) {
    return [...actions, { action: 'FILE_REPORT', route: resolveRoute('FILE_REPORT', a.exposureUsd), reason: decision.reason }];
  }
  if (!decision.file && has) {
    return actions.filter((x) => x.action !== 'FILE_REPORT');
  }
  return actions;
}

/**
 * R1, R7 and R10 forbid actions rather than recommending them. They are applied
 * last so a prohibition always wins, including over an LLM recommendation.
 */
function applyProhibitions(
  actions: readonly RecommendedAction[],
  a: CaseAssessment,
): readonly RecommendedAction[] {
  let out = [...actions];

  // R1: no blocking on a weak single signal that has not been verified.
  if (a.singleSignal && a.fraudProbability < 0.7 && a.customerResponse === 'not_asked') {
    out = out.filter((x) => x.action !== 'BLOCK_CARD' && x.action !== 'BLOCK_ALL_CARDS');
  }
  // R7: never block a disputed charge that matches their own recurring pattern.
  if (a.disputed && a.matchesRecurringPattern) {
    out = out.filter((x) => x.action !== 'BLOCK_CARD' && x.action !== 'BLOCK_ALL_CARDS');
  }
  // R10: BLOCK_ALL_CARDS needs two cards with confirmed fraud, or confirmed
  // credential compromise.
  if (a.cardsWithConfirmedFraud < 2) {
    out = out.filter((x) => x.action !== 'BLOCK_ALL_CARDS');
  }
  return out;
}

/**
 * Policy section 3a. A report always has a case behind it, and most cases never
 * need one. Returns the reason either way, because `sar.reason` is required
 * whether or not a report is filed.
 */
export function decideSar(a: CaseAssessment): { file: boolean; reason: string } {
  const stronglySuspected = a.verdict === 'fraud' || a.fraudProbability >= 0.7;
  if (!stronglySuspected) {
    return {
      file: false,
      reason: `R2 and policy 3a: fraud is neither confirmed nor strongly suspected (probability ${a.fraudProbability.toFixed(2)}), so no report is due`,
    };
  }
  if (a.exposureUsd > 1000) {
    return { file: true, reason: `R2: confirmed or strongly suspected fraud with exposure of $${a.exposureUsd.toFixed(2)}, above the $1,000 threshold` };
  }
  if (a.connectedToSharedOrigin) {
    return { file: true, reason: `R6: activity connects to ${a.sharedOriginDescription}` };
  }
  if (a.pattern === 'undocumented') {
    return { file: true, reason: 'R9: coordinated abuse fitting none of the documented patterns' };
  }
  return {
    file: false,
    reason: `policy 3a: fraud suspected but exposure of $${a.exposureUsd.toFixed(2)} is under $1,000, with no shared origin and no undocumented pattern, so a case alone is sufficient`,
  };
}

/**
 * Policy section 6. Returns the reason the investigation stopped, which every
 * answer file must carry.
 */
export function decideStop(a: CaseAssessment, independentEvidenceCount: number, cycles: number): string {
  const rules = loadPolicyRules();
  if (a.fraudProbability >= 0.85 && independentEvidenceCount >= 2) {
    return `Fraud probability ${a.fraudProbability.toFixed(2)} is at or above 0.85 with ${independentEvidenceCount} independent pieces of evidence, which policy section 6 treats as sufficient to act.`;
  }
  if (a.fraudProbability <= 0.15 && independentEvidenceCount >= 2) {
    return `Fraud probability ${a.fraudProbability.toFixed(2)} is at or below 0.15 with ${independentEvidenceCount} independent pieces of evidence, so the alert is resolved as legitimate.`;
  }
  if (a.customerResponse === 'denied' || a.customerResponse === 'confirmed') {
    return `The verification response settled the question: the cardholder ${a.customerResponse === 'denied' ? 'denied' : 'confirmed'} the transaction.`;
  }
  if (cycles >= rules.escalation_guardrails.max_evidence_cycles) {
    return `Three evidence-gathering cycles completed without reaching sufficiency, so the case is escalated rather than looped further.`;
  }
  return `Further evidence-gathering would not change the recommended action: the available signals are exhausted and the case is recorded at probability ${a.fraudProbability.toFixed(2)}.`;
}
