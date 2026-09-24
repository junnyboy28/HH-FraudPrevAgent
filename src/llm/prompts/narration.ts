// Prompt templates for the two narration calls, plus the evidence brief that
// both are given.
//
// Per CLAUDE.md, prompt text lives here and never inside the orchestrator or a
// tool. The briefs are built only from evidence the investigation actually
// retrieved, so the model has nothing to work from except real findings. That
// is what makes "explanations must cite actual evidence" enforceable rather
// than aspirational.

import type { NarrationInput } from '../../orchestrator/case-orchestrator.js';

const SHARED_RULES = `
Rules you must follow:
- Write only from the EVIDENCE and CASE FACTS given below. Never introduce a
  transaction, card, customer, device, amount, date or prior case that does not
  appear there.
- The bank's model risk score is an input, not a verdict. Never describe it as
  proof of fraud, and never treat a high score as a finding on its own.
- Do not hedge with filler ("it appears that", "there may possibly be"). State
  what the evidence shows and, where the evidence is weak, say so plainly.
- No em dashes. Use commas, periods or parentheses.
- Plain prose only. No markdown, no bullet points, no headings.
`.trim();

export const CASE_SUMMARY_SYSTEM = `
You are a bank fraud analyst writing the summary field of an internal case file.
Another analyst will read this to understand the case in about twenty seconds.

Write two to six sentences covering: what was flagged and why, what the graph
evidence showed, what the prior closed cases suggested, and what you concluded
including how confident you are. If additional evidence was requested, say what
was asked and what the assumed answer was.

${SHARED_RULES}

Output the summary text only, with no preamble.
`.trim();

export const SAR_NARRATIVE_SYSTEM = `
You are a bank compliance officer writing the narrative of a Suspicious Activity
Report that will be read by a financial regulator. It must stand on its own
without the case file attached.

Write six to twelve sentences covering, in this order: who (the customer, the
cards, the devices), what happened, when (with dates), where (billing regions
and channels), how the activity was carried out, and why it is suspicious. End
with the total suspicious amount and the action the bank took or recommended.

${SHARED_RULES}

Output the narrative text only, with no preamble, heading or signature.
`.trim();

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The evidence brief given to both calls. Deliberately compact: it is the input
 * side of the token bill, and the assembled evidence is already the distilled
 * form of what the graph returned.
 */
export function buildEvidenceBrief(input: NarrationInput): string {
  const { entry, flagged, assessment, patterns, evidence, similar, actionsInitial, actionsFinal, requests, affected } =
    input;

  const lines: string[] = [];

  lines.push('CASE FACTS');
  lines.push(`case id: ${entry.caseId}`);
  lines.push(`trigger: ${entry.triggerType}`);
  lines.push(`trigger text: ${entry.triggerText}`);
  lines.push(
    `flagged transaction: ${flagged.txnId}, ${money(Math.abs(flagged.amount))}, ${flagged.channel}, ` +
      `product code ${flagged.productCd}, ${flagged.ts}` +
      (flagged.addr1 !== '' ? `, billing region ${flagged.addr1}` : '') +
      `, model risk score ${flagged.riskScore}`,
  );
  lines.push(`card: ${entry.cardId}, customer: ${entry.customerId}`);
  if (flagged.deviceProfile !== '') {
    lines.push(
      `device profile: ${flagged.deviceProfile}` +
        (flagged.deviceNew !== '' ? ` (marked ${flagged.deviceNew} for this account)` : '') +
        (flagged.proxy !== '' ? `, proxy ${flagged.proxy}` : ''),
    );
  }
  lines.push(
    `assessment: fraud probability ${assessment.fraudProbability.toFixed(2)}, verdict ${assessment.verdict}, ` +
      `pattern ${assessment.pattern}, exposure ${money(assessment.exposureUsd)}`,
  );
  if (affected.length > 0) {
    lines.push(
      `transactions in the episode (${affected.length}): ` +
        affected.slice(0, 12).map((t) => `${t.txnId} ${money(Math.abs(t.amount))} on ${t.ts}`).join('; ') +
        (affected.length > 12 ? `; and ${affected.length - 12} more` : ''),
    );
  }
  if (assessment.connectedToSharedOrigin) {
    lines.push(`shared origin: ${assessment.sharedOriginDescription}`);
  }

  if (patterns.length > 0) {
    lines.push('');
    lines.push('PATTERN MATCHES');
    for (const p of patterns) {
      lines.push(`- ${p.pattern} at strength ${p.strength.toFixed(2)}`);
      if (p.description !== undefined) lines.push(`  described as: ${p.description}`);
    }
  }

  lines.push('');
  lines.push('EVIDENCE');
  for (const e of evidence) {
    lines.push(`- [${e.source}] ${e.claim} (source: ${e.ref})`);
  }

  if (similar.length > 0) {
    lines.push('');
    lines.push('PRIOR CLOSED CASES RETRIEVED AS MEMORY');
    for (const s of similar.slice(0, 6)) {
      lines.push(
        `- ${s.caseId}: ${s.outcome}, pattern ${s.pattern}, exposure ${money(s.exposureUsd)}, ` +
          `retrieved by ${s.basis.join(' and ')}`,
      );
    }
  }

  if (requests.length > 0) {
    lines.push('');
    lines.push('EVIDENCE REQUESTED DURING THE INVESTIGATION');
    for (const r of requests) {
      lines.push(`- ${r.type} after step ${r.asked_after_step}: ${r.assumed_response}`);
    }
  }

  lines.push('');
  lines.push('RECOMMENDED ACTIONS');
  lines.push(`before requesting evidence: ${actionsInitial.map((a) => `${a.action} (${a.route})`).join(', ')}`);
  lines.push(`after evidence: ${actionsFinal.map((a) => `${a.action} (${a.route})`).join(', ')}`);

  return lines.join('\n');
}
