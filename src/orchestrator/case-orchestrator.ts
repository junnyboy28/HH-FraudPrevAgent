// CaseOrchestrator: the 8-step investigation flow as an explicit state machine.
//
// States and transitions are defined in docs/architecture.md section 3.3 and
// agent.md section 3. Each transition appends to the case trace, which IS the
// explainability requirement rather than a separate feature.
//
// The division of labour is deliberate: this class sequences the flow, the
// evidence source answers questions about the graph, src/tools/patterns.ts
// decides what the activity looks like, and src/orchestrator/policy-engine.ts
// decides what may be done about it. No prompt text or graph query lives here.

import type {
  CasePackEntry,
  EvidenceSource,
  SimilarCase,
  Txn,
} from '../tools/evidence-types.js';
import { detectAllPatterns, type PatternMatch } from '../tools/patterns.js';
import { PolicyStore } from '../tools/policy-store.js';
import {
  decideSar,
  decideStop,
  resolveRoute,
  selectActions,
  type CaseAssessment,
  type CustomerResponse,
  type RecommendedAction,
} from './policy-engine.js';

export const CASE_STATES = [
  'TRIGGERED',
  'INVESTIGATING',
  'EVIDENCE_GATHERED',
  'ASSESSING',
  'NEEDS_MORE_EVIDENCE',
  'ACTION_SELECTED',
  'EXPLAINED',
  'MEMORY_UPDATED',
  'CLOSED',
] as const;

export type CaseState = (typeof CASE_STATES)[number];

export interface TraceStep {
  readonly step: number;
  readonly state: CaseState;
  readonly summary: string;
}

export interface EvidenceItem {
  readonly claim: string;
  readonly source: 'graph' | 'document' | 'customer' | 'external';
  readonly ref: string;
  readonly entity_ids: readonly string[];
}

export interface EvidenceRequest {
  readonly type: 'customer_validation' | 'step_up_auth' | 'analyst_info';
  readonly asked_after_step: number;
  readonly assumed_response: string;
}

/** The answer file, exactly as the dataset's Answer Format section defines it. */
export interface AnswerFile {
  readonly case_id: string;
  readonly case: {
    readonly status: 'open' | 'closed_fraud' | 'closed_legitimate' | 'escalated';
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
  readonly evidence_requests: readonly EvidenceRequest[];
  readonly next_best_actions: {
    readonly initial: readonly RecommendedAction[];
    readonly final: readonly RecommendedAction[];
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

/** Writes the case to the graph and returns its vertex id. */
export interface CaseWriter {
  writeCase(answer: AnswerFile): Promise<string>;
}

/** Generates the prose fields. Deterministic templates or an LLM. */
export interface Narrator {
  summarize(input: NarrationInput): Promise<string>;
  sarNarrative(input: NarrationInput): Promise<string>;
  /** Tokens consumed so far, for the answer file. */
  readonly tokensUsed: number;
}

export interface NarrationInput {
  readonly entry: CasePackEntry;
  readonly flagged: Txn;
  readonly assessment: CaseAssessment;
  readonly patterns: readonly PatternMatch[];
  readonly evidence: readonly EvidenceItem[];
  readonly similar: readonly SimilarCase[];
  readonly actionsInitial: readonly RecommendedAction[];
  readonly actionsFinal: readonly RecommendedAction[];
  readonly requests: readonly EvidenceRequest[];
  readonly affected: readonly Txn[];
}

function dateOnly(ts: string): string {
  return ts.slice(0, 10);
}

export class CaseOrchestrator {
  private toolCalls = 0;
  private readonly trace: TraceStep[] = [];
  private step = 0;

  constructor(
    private readonly evidence: EvidenceSource,
    private readonly narrator: Narrator,
    private readonly writer: CaseWriter | null = null,
    private readonly policy: PolicyStore = new PolicyStore(),
  ) {}

  private record(state: CaseState, summary: string): void {
    this.step += 1;
    this.trace.push({ step: this.step, state, summary });
  }

  getTrace(): readonly TraceStep[] {
    return this.trace;
  }

  /**
   * Runs one case end to end and returns its answer file.
   *
   * The flow follows agent.md section 3: trigger, investigate, gather, assess,
   * gather more if the policy calls for it, act, explain, update memory.
   */
  async run(entry: CasePackEntry): Promise<AnswerFile> {
    const started = Date.now();
    this.toolCalls = 0;
    this.record('TRIGGERED', `${entry.triggerType} trigger on transaction ${entry.flaggedTxnId}`);

    // --- INVESTIGATING: what am I looking at, and has it happened before ---
    const nb = await this.call(() => this.evidence.getEntityNeighborhood(entry.flaggedTxnId));
    const timeline = await this.call(() => this.evidence.getCardTimeline(entry.cardId));
    const profile = await this.call(() => this.evidence.getAccountProfile(entry.customerId));
    const shared = await this.call(() => this.evidence.findSharedDevicesAcrossAccounts(entry.customerId));
    const linkedFraud = await this.call(() => this.evidence.findLinkedFraudHistory(entry.customerId));
    this.record(
      'INVESTIGATING',
      `pulled the neighborhood of ${entry.flaggedTxnId}, ${timeline.length} transactions on ` +
        `${entry.cardId}, and ${linkedFraud.direct.length + linkedFraud.viaSharedDevice.length} ` +
        `prior confirmed-fraud cases reachable from this account`,
    );

    // --- EVIDENCE_GATHERED: run the pattern detectors ---
    const cohort =
      nb.flagged.deviceProfile !== ''
        ? await this.call(() => this.evidence.getDeviceCohort(nb.flagged.deviceProfile, nb.flagged.ts, 30))
        : [];
    const patterns = detectAllPatterns({
      timeline,
      flagged: nb.flagged,
      profile,
      sharedDevices: shared,
      deviceCohort: cohort,
    });
    const top = patterns[0] ?? null;
    const similar = await this.call(() =>
      this.evidence.findSimilarClosedCases(entry.customerId, top?.pattern ?? '', nb.flagged.addr1, 8),
    );
    this.record(
      'EVIDENCE_GATHERED',
      patterns.length > 0
        ? `pattern detectors matched ${patterns.map((p) => `${p.pattern} at ${p.strength.toFixed(2)}`).join(', ')}`
        : 'no documented fraud pattern matched the activity on this card',
    );

    // --- ASSESSING ---
    const evidence = this.buildEvidence(entry, nb, profile, patterns, similar, linkedFraud, timeline);

    // GraphRAG: the graph evidence just assembled becomes the retrieval query,
    // so the policy text that comes back is the policy that matches what was
    // actually found. Retrieved chunks join the bundle as `document` evidence
    // and are cited by their chunk id.
    const retrievalQuery = [
      patterns.map((p) => `${p.pattern} ${p.evidence.map((e) => e.claim).join(' ')}`).join(' '),
      evidence.map((e) => e.claim).join(' '),
      entry.triggerText,
    ].join(' ');
    const policyChunks = await this.call(() => this.policy.retrieveForEvidence(retrievalQuery, 4));
    for (const chunk of policyChunks) {
      evidence.push({
        claim: `Policy ${chunk.section} (${chunk.title}): ${chunk.text.replace(/\s+/g, ' ').slice(0, 320)}`,
        source: 'document',
        ref: `policydoc:${chunk.chunkId}`,
        entity_ids: [chunk.chunkId],
      });
    }
    if (policyChunks.length > 0) {
      this.record(
        'EVIDENCE_GATHERED',
        `retrieved ${policyChunks.length} policy and pattern chunks from ${this.policy.source} ` +
          `(${policyChunks.map((c) => c.section).join(', ')})`,
      );
    }

    let assessment = this.assess(entry, nb.flagged, timeline, profile, patterns, similar, linkedFraud, shared, cohort, 'not_asked');
    this.record(
      'ASSESSING',
      `fraud probability ${assessment.fraudProbability.toFixed(2)}, verdict ${assessment.verdict}, ` +
        `pattern ${assessment.pattern}, exposure $${assessment.exposureUsd.toFixed(2)}`,
    );

    const actionsInitial = selectActions(assessment);

    // --- NEEDS_MORE_EVIDENCE: ask, simulate the answer, reassess ---
    const requests: EvidenceRequest[] = [];
    const evidenceAfter = [...evidence];
    let cycles = 0;
    const needsEvidence = actionsInitial.some(
      (a) => a.action === 'VERIFY_WITH_CUSTOMER' || a.action === 'STEP_UP_AUTH',
    );
    if (needsEvidence) {
      cycles = 1;
      const response = this.simulateCustomerResponse(assessment);
      requests.push({
        type: 'customer_validation',
        asked_after_step: this.step,
        assumed_response: response.text,
      });
      evidenceAfter.push({
        claim: response.text,
        source: 'customer',
        ref: 'evidence_request:1',
        entity_ids: [entry.flaggedTxnId],
      });
      this.record(
        'NEEDS_MORE_EVIDENCE',
        `requested customer validation under R1 and assumed the response from the evidence: ${response.kind}`,
      );
      assessment = this.assess(
        entry, nb.flagged, timeline, profile, patterns, similar, linkedFraud, shared, cohort, response.kind,
      );
      this.record(
        'EVIDENCE_GATHERED',
        `reassessed after the response: probability ${assessment.fraudProbability.toFixed(2)}, verdict ${assessment.verdict}`,
      );
    }

    // --- ACTION_SELECTED ---
    const actionsFinal = selectActions(assessment);
    for (const action of actionsFinal) {
      // The gate decides, not the recommendation. Autonomous actions are the
      // only ones the agent may execute itself.
      const route = resolveRoute(action.action, assessment.exposureUsd);
      if (route !== action.route) {
        throw new Error(`Route mismatch for ${action.action}: ${action.route} vs gate ${route}`);
      }
    }
    this.record(
      'ACTION_SELECTED',
      `recommended ${actionsFinal.map((a) => `${a.action} (${a.route})`).join(', ')}`,
    );

    // --- EXPLAINED ---
    const affected = assessment.exposureUsd > 0
      ? timeline.filter((t) => (top?.affectedTxnIds ?? []).includes(t.txnId))
      : [];
    const narrationInput: NarrationInput = {
      entry, flagged: nb.flagged, assessment, patterns, evidence: evidenceAfter, similar,
      actionsInitial, actionsFinal, requests, affected,
    };
    const summary = await this.narrator.summarize(narrationInput);
    const sarDecision = decideSar(assessment);
    const narrative = sarDecision.file ? await this.narrator.sarNarrative(narrationInput) : '';
    this.record('EXPLAINED', `explanation generated citing ${evidenceAfter.length} pieces of evidence`);

    const independent = new Set(evidenceAfter.map((e) => e.ref.split('(')[0])).size;
    const stopReason = decideStop(assessment, independent, cycles);

    const connectedCardIds = [
      ...new Set(
        [...linkedFraud.viaSharedDevice.map((c) => c.cardId), ...(top?.pattern === 'undocumented' ? [] : [])].filter(
          (c) => c !== '' && c !== entry.cardId,
        ),
      ),
    ].slice(0, 20);

    const connectedDeviceProfiles =
      nb.flagged.deviceProfile !== '' && shared.some((s) => s.deviceProfile === nb.flagged.deviceProfile)
        ? [nb.flagged.deviceProfile]
        : [];

    const status: AnswerFile['case']['status'] = actionsFinal.some((a) => a.action === 'ESCALATE_TO_ANALYST')
      ? 'escalated'
      : actionsFinal.some((a) => a.action === 'CLOSE_NO_FRAUD')
        ? 'closed_legitimate'
        : assessment.verdict === 'fraud'
          ? 'closed_fraud'
          : 'open';

    const answer: AnswerFile = {
      case_id: entry.caseId,
      case: {
        status,
        verdict: assessment.verdict,
        fraud_probability: Number(assessment.fraudProbability.toFixed(2)),
        pattern: assessment.pattern,
        pattern_description: top?.description ?? '',
        affected_txn_ids: affected.map((t) => t.txnId),
        first_suspicious_txn_id: affected[0]?.txnId ?? '',
        connected_card_ids: connectedCardIds,
        connected_device_profiles: connectedDeviceProfiles,
        exposure_usd: Number(assessment.exposureUsd.toFixed(2)),
        evidence: evidenceAfter,
        similar_prior_cases: similar.map((s) => s.caseId),
        summary,
        written_to_graph: false,
        graph_case_id: '',
      },
      evidence_requests: requests,
      next_best_actions: {
        initial: actionsInitial,
        final: actionsFinal,
        what_changed: this.describeChange(actionsInitial, actionsFinal, requests),
      },
      sar: {
        file: sarDecision.file,
        reason: sarDecision.reason,
        narrative,
        subjects: sarDecision.file
          ? [entry.customerId, entry.cardId, ...connectedCardIds, ...connectedDeviceProfiles]
          : [],
        total_amount_usd: sarDecision.file ? Number(assessment.exposureUsd.toFixed(2)) : 0,
        activity_dates: sarDecision.file && affected.length > 0
          ? [dateOnly(affected[0]?.ts ?? ''), dateOnly(affected[affected.length - 1]?.ts ?? '')]
          : [],
      },
      stop_reason: stopReason,
      tool_calls: this.toolCalls,
      tokens: this.narrator.tokensUsed,
      latency_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    };

    // --- MEMORY_UPDATED ---
    if (this.writer) {
      const graphCaseId = await this.writer.writeCase(answer);
      this.record('MEMORY_UPDATED', `case written to the graph as ${graphCaseId}`);
      return {
        ...answer,
        case: { ...answer.case, written_to_graph: true, graph_case_id: graphCaseId },
      };
    }
    this.record('MEMORY_UPDATED', 'no graph writer configured, case not persisted');
    return answer;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    this.toolCalls += 1;
    return fn();
  }

  /**
   * The customer reply the dataset does not provide. agent.md section 10 makes
   * this evidence-driven on purpose: always assuming denial would block
   * legitimate customers, and roughly half the exam cases are legitimate.
   */
  private simulateCustomerResponse(a: CaseAssessment): { kind: CustomerResponse; text: string } {
    if (a.fraudProbability >= 0.6) {
      return {
        kind: 'denied',
        text:
          `Assumed denial. The cardholder states they did not make this transaction and still holds the card. ` +
          `Assumption basis: the graph evidence already supports fraud at probability ${a.fraudProbability.toFixed(2)} ` +
          `before asking, so a denial is the consistent reply.`,
      };
    }
    if (a.fraudProbability <= 0.35) {
      return {
        kind: 'confirmed',
        text:
          `Assumed confirmation. The cardholder recognises the transaction. Assumption basis: the activity ` +
          `fits this cardholder's established history and the evidence supports fraud only at ` +
          `probability ${a.fraudProbability.toFixed(2)}.`,
      };
    }
    return {
      kind: 'no_reply',
      text:
        `Assumed no reply within 24 hours. Assumption basis: the evidence is genuinely ambiguous at ` +
        `probability ${a.fraudProbability.toFixed(2)}, so neither a denial nor a confirmation can be ` +
        `assumed without inventing facts; policy R4 covers this case.`,
    };
  }

  /** Assembles the evidence list, every item pointing at the query behind it. */
  private buildEvidence(
    entry: CasePackEntry,
    nb: Awaited<ReturnType<EvidenceSource['getEntityNeighborhood']>>,
    profile: Awaited<ReturnType<EvidenceSource['getAccountProfile']>>,
    patterns: readonly PatternMatch[],
    similar: readonly SimilarCase[],
    linkedFraud: Awaited<ReturnType<EvidenceSource['findLinkedFraudHistory']>>,
    timeline: readonly Txn[],
  ): EvidenceItem[] {
    const out: EvidenceItem[] = [
      {
        claim:
          `The flagged transaction is $${nb.flagged.amount.toFixed(2)} ${nb.flagged.channel} on ` +
          `${nb.flagged.ts}, product code ${nb.flagged.productCd}, billing region ` +
          `${nb.flagged.addr1 || 'unrecorded'}, with the bank's model score at ${nb.flagged.riskScore}. ` +
          `The score is an input and not a verdict.`,
        source: 'graph',
        ref: `query:getEntityNeighborhood(txn_id=${entry.flaggedTxnId})`,
        entity_ids: [entry.flaggedTxnId, entry.cardId, entry.customerId],
      },
      {
        claim:
          `The cardholder has ${profile.nTransactions} transactions between ${profile.firstSeen} and ` +
          `${profile.lastSeen}, across ${profile.regionsUsed.length} billing regions and ` +
          `${profile.channelsUsed.join(' and ')} channels, with a median amount of ` +
          `$${profile.medianAmount.toFixed(2)}.`,
        source: 'graph',
        ref: `query:getAccountProfile(account_id=${entry.customerId})`,
        entity_ids: [entry.customerId, ...profile.cardIds],
      },
    ];
    for (const p of patterns) out.push(...p.evidence.map((e) => ({ ...e, source: 'graph' as const, entity_ids: e.entityIds })));
    if (linkedFraud.direct.length > 0) {
      out.push({
        claim:
          `This account has ${linkedFraud.direct.length} prior confirmed-fraud case(s) of its own: ` +
          `${linkedFraud.direct.slice(0, 4).map((c) => `${c.caseId} (${c.pattern})`).join(', ')}.`,
        source: 'graph',
        ref: `query:findLinkedFraudHistory(account_id=${entry.customerId})`,
        entity_ids: linkedFraud.direct.slice(0, 8).map((c) => c.caseId),
      });
    }
    if (similar.length > 0) {
      const confirmed = similar.filter((s) => s.outcome === 'confirmed_fraud').length;
      out.push({
        claim:
          `Case memory returned ${similar.length} structurally similar closed cases, of which ${confirmed} ` +
          `were confirmed fraud and ${similar.length - confirmed} were cleared as false alarms. ` +
          `Retrieved by ${[...new Set(similar.flatMap((s) => s.basis))].join(' and ')}.`,
        source: 'graph',
        ref: `query:findSimilarClosedCases(account_id=${entry.customerId})`,
        entity_ids: similar.map((s) => s.caseId),
      });
    }
    if (timeline.length > 0) {
      out.push({
        claim: `The card carries ${timeline.length} transactions in total, which is the baseline the pattern checks ran against.`,
        source: 'graph',
        ref: `query:getCardTimeline(card_id=${entry.cardId})`,
        entity_ids: [entry.cardId],
      });
    }
    return out;
  }

  /** Turns evidence into a probability, a verdict and the policy inputs. */
  private assess(
    entry: CasePackEntry,
    flagged: Txn,
    timeline: readonly Txn[],
    profile: Awaited<ReturnType<EvidenceSource['getAccountProfile']>>,
    patterns: readonly PatternMatch[],
    similar: readonly SimilarCase[],
    linkedFraud: Awaited<ReturnType<EvidenceSource['findLinkedFraudHistory']>>,
    shared: Awaited<ReturnType<EvidenceSource['findSharedDevicesAcrossAccounts']>>,
    cohort: readonly string[],
    customerResponse: CustomerResponse,
  ): CaseAssessment {
    const top = patterns[0] ?? null;
    let probability = top?.strength ?? 0.1;

    // Prior confirmed fraud on this very account raises it; a history of cleared
    // alerts lowers it. Both are memory doing its job.
    if (linkedFraud.direct.length > 0) probability += 0.08;
    const clearedShare =
      similar.length > 0 ? similar.filter((s) => s.outcome === 'cleared').length / similar.length : 0;
    if (clearedShare > 0.5) probability -= 0.05;

    // The bank's score is a reason to look, never a verdict, so it moves the
    // number only slightly and only when evidence already points somewhere.
    if (entry.riskScore !== null && top !== null) {
      probability += (entry.riskScore - 0.5) * 0.1;
    }

    // A customer report is itself evidence, but the README is explicit that
    // disputes are often recurring charges the cardholder forgot.
    if (entry.triggerType === 'customer_report') probability += 0.12;

    if (customerResponse === 'denied') probability = Math.max(probability, 0.86);
    if (customerResponse === 'confirmed') probability = Math.min(probability, 0.1);

    probability = Math.max(0.02, Math.min(0.97, probability));

    const verdict: CaseAssessment['verdict'] =
      probability >= 0.7 ? 'fraud' : probability <= 0.25 ? 'legitimate' : 'uncertain';

    const affected = top !== null && verdict !== 'legitimate' ? top.affectedTxnIds : [];
    const exposure = timeline
      .filter((t) => affected.includes(t.txnId))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const ringLink = shared.find((s) => s.strength === 'ring' && s.deviceProfile === flagged.deviceProfile);
    const strongLink = shared.find((s) => s.strength === 'strong');
    const sharedOrigin =
      ringLink !== undefined
        ? `a device profile ("${ringLink.deviceProfile}") used by ${cohort.length} cardholders within a month`
        : strongLink !== undefined
          ? `a device profile shared with account ${strongLink.otherAccountId}`
          : linkedFraud.viaSharedDevice.length > 0
            ? `another cardholder's confirmed fraud reachable through a shared device`
            : '';

    // A recurring charge: same amount seen repeatedly on this card before.
    const sameAmountBefore = timeline.filter(
      (t) => t.dt < flagged.dt && Math.abs(t.amount - flagged.amount) < 0.01,
    ).length;

    return {
      fraudProbability: probability,
      verdict,
      pattern: verdict === 'legitimate' ? 'none' : (top?.pattern ?? 'none'),
      exposureUsd: exposure,
      singleSignal: patterns.length <= 1 && linkedFraud.direct.length === 0,
      customerResponse,
      connectedToSharedOrigin: sharedOrigin !== '',
      sharedOriginDescription: sharedOrigin,
      matchesRecurringPattern: sameAmountBefore >= 2,
      evidenceConflicts:
        patterns.length > 1 && clearedShare > 0.5 && probability > 0.3 && probability < 0.7,
      cardsWithConfirmedFraud: new Set(linkedFraud.direct.map((c) => c.cardId)).size,
      clearedPurchaseAmount:
        top?.pattern === 'card_testing'
          ? Math.max(0, ...timeline.filter((t) => affected.includes(t.txnId)).map((t) => Math.abs(t.amount)))
          : 0,
      disputed: entry.triggerType === 'customer_report',
    };
  }

  private describeChange(
    initial: readonly RecommendedAction[],
    final: readonly RecommendedAction[],
    requests: readonly EvidenceRequest[],
  ): string {
    if (requests.length === 0) return 'nothing';
    const before = new Set(initial.map((a) => a.action));
    const after = new Set(final.map((a) => a.action));
    const added = [...after].filter((a) => !before.has(a));
    const removed = [...before].filter((a) => !after.has(a));
    if (added.length === 0 && removed.length === 0) {
      return 'The assumed response did not change the recommendation: the same actions remain appropriate.';
    }
    const parts: string[] = [];
    if (added.length > 0) parts.push(`added ${added.join(', ')}`);
    if (removed.length > 0) parts.push(`dropped ${removed.join(', ')}`);
    return `The assumed customer response ${parts.join(' and ')}.`;
  }
}
