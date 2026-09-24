// Deterministic narrator: builds the case summary and the SAR narrative from
// the evidence that was actually gathered, with no model call.
//
// It exists for two reasons. First, it is the fallback when no ANTHROPIC_API_KEY
// is configured, so the benchmark can always produce answer files. Second, it
// guarantees the property the dataset README cares about most: every sentence
// is derived from a specific piece of retrieved evidence, so an explanation can
// never reference something the investigation did not find.
//
// src/llm/claude-narrator.ts is the model-backed version and produces better
// prose. Both satisfy the same interface.

import type { NarrationInput, Narrator } from '../orchestrator/case-orchestrator.js';

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export class TemplateNarrator implements Narrator {
  readonly tokensUsed = 0;

  async summarize(input: NarrationInput): Promise<string> {
    const { entry, flagged, assessment, patterns, similar, actionsFinal, requests } = input;
    const parts: string[] = [];

    const trigger =
      entry.triggerType === 'customer_report'
        ? `The cardholder disputed a ${money(Math.abs(flagged.amount))} ${flagged.channel} transaction on ${flagged.ts.slice(0, 10)}`
        : entry.triggerType === 'analyst_request'
          ? `An analyst opened this case on a ${money(Math.abs(flagged.amount))} ${flagged.channel} transaction on ${flagged.ts.slice(0, 10)}`
          : `The bank's model scored a ${money(Math.abs(flagged.amount))} ${flagged.channel} transaction at ${flagged.riskScore} on ${flagged.ts.slice(0, 10)}`;
    parts.push(`${trigger} on card ${entry.cardId}.`);

    if (patterns.length === 0) {
      parts.push(
        `No documented fraud pattern matched: the transaction sits within this cardholder's established ` +
          `history of amounts, regions and channels, and the card's surrounding activity shows no testing ` +
          `sequence, no burst and no out-of-region use.`,
      );
    } else {
      const top = patterns[0];
      if (top !== undefined) {
        parts.push(
          `The evidence fits ${top.pattern.replace(/_/g, ' ')}: ${top.evidence[0]?.claim ?? 'see the evidence list'}.`,
        );
        if (top.evidence.length > 1) {
          parts.push(`${top.evidence.slice(1).map((e) => e.claim).join('; ')}.`);
        }
      }
    }

    if (similar.length > 0) {
      const confirmed = similar.filter((s) => s.outcome === 'confirmed_fraud');
      const cleared = similar.filter((s) => s.outcome === 'cleared');
      parts.push(
        `Case memory returned ${similar.length} similar closed cases (${confirmed.length} confirmed fraud, ` +
          `${cleared.length} cleared), including ${similar.slice(0, 3).map((s) => s.caseId).join(', ')}.`,
      );
    }

    if (requests.length > 0) {
      parts.push(
        `Because the case rested on a weak signal, the cardholder was asked to validate the transaction; ` +
          `the assumed response is recorded in evidence_requests.`,
      );
    }

    parts.push(
      `Assessed fraud probability ${assessment.fraudProbability.toFixed(2)}, verdict ${assessment.verdict}` +
        (assessment.exposureUsd > 0 ? `, exposure ${money(assessment.exposureUsd)}` : '') +
        `. Recommended: ${actionsFinal.map((a) => `${a.action} (${a.route})`).join(', ')}.`,
    );

    return parts.join(' ');
  }

  async sarNarrative(input: NarrationInput): Promise<string> {
    const { entry, flagged, assessment, patterns, evidence, affected, similar } = input;
    const first = affected[0] ?? flagged;
    const last = affected[affected.length - 1] ?? flagged;
    const s: string[] = [];

    // Who.
    s.push(
      `Customer ${entry.customerId}, holder of card ${entry.cardId}, is the subject of this report.`,
    );
    // What and when.
    s.push(
      affected.length > 1
        ? `Between ${first.ts} and ${last.ts}, ${affected.length} transactions totalling ` +
          `${money(assessment.exposureUsd)} were identified as part of a single suspicious episode on that card.`
        : `On ${flagged.ts}, a transaction of ${money(Math.abs(flagged.amount))} on that card was identified as suspicious.`,
    );
    // Where and how.
    s.push(
      `The activity was ${flagged.channel === 'online' ? 'card-not-present (online)' : 'card-present (in person)'}` +
        (flagged.addr1 !== '' ? `, billed in region ${flagged.addr1} (country code ${flagged.addr2 || 'unrecorded'})` : '') +
        (flagged.deviceProfile !== '' ? `, from device profile "${flagged.deviceProfile}"` : '') +
        `.`,
    );
    // Why suspicious: the actual evidence.
    const top = patterns[0];
    if (top !== undefined) {
      s.push(
        `The pattern identified is ${top.pattern.replace(/_/g, ' ')}. ` +
          top.evidence.map((e) => e.claim.charAt(0).toUpperCase() + e.claim.slice(1)).join('. ') + '.',
      );
    }
    const customerEvidence = evidence.find((e) => e.source === 'customer');
    if (customerEvidence) {
      s.push(`Cardholder contact: ${customerEvidence.claim}`);
    }
    if (similar.length > 0) {
      const confirmed = similar.filter((x) => x.outcome === 'confirmed_fraud').slice(0, 3);
      if (confirmed.length > 0) {
        s.push(
          `The bank's closed-case history contains structurally similar confirmed fraud: ` +
            `${confirmed.map((c) => `${c.caseId} (${c.pattern}, ${money(c.exposureUsd)})`).join(', ')}.`,
        );
      }
    }
    // Why it is reportable.
    s.push(
      `This activity is reported because the assessed fraud probability is ` +
        `${assessment.fraudProbability.toFixed(2)} and ${assessment.connectedToSharedOrigin ? `it connects to ${assessment.sharedOriginDescription}` : `the exposure of ${money(assessment.exposureUsd)} meets the filing threshold`}.`,
    );
    s.push(
      `Total suspicious amount: ${money(assessment.exposureUsd)}. ` +
        `The bank's detection model scored the flagged transaction at ${flagged.riskScore}, which was treated as ` +
        `a reason to investigate rather than as a determination.`,
    );
    return s.join(' ');
  }
}
