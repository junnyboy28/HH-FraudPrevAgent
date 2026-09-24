// Dev probe: runs pattern detection across all 20 exam cases and prints a
// summary, so the spread of verdicts can be sanity-checked by eye.
import { LocalEvidenceSource } from '../src/tools/local-evidence-source.js';
import { detectAllPatterns } from '../src/tools/patterns.js';

async function main(): Promise<void> {
  const src = new LocalEvidenceSource();
  const pack = await src.getCasePack();
  console.log('case     trig            $flagged risk  patterns (strength)                                 cohort');
  console.log('-------- --------------- -------- ----- --------------------------------------------------- ------');
  for (const c of pack) {
    const nb = await src.getEntityNeighborhood(c.flaggedTxnId);
    const timeline = await src.getCardTimeline(c.cardId);
    const profile = await src.getAccountProfile(c.customerId);
    const shared = await src.findSharedDevicesAcrossAccounts(c.customerId);
    const cohort = nb.flagged.deviceProfile
      ? await src.getDeviceCohort(nb.flagged.deviceProfile, nb.flagged.ts, 30)
      : [];
    const matches = detectAllPatterns({
      timeline, flagged: nb.flagged, profile, sharedDevices: shared, deviceCohort: cohort,
    });
    const desc = matches.length
      ? matches.map((m) => `${m.pattern}(${m.strength.toFixed(2)})`).join(' ')
      : '(none)';
    console.log(
      `${c.caseId} ${c.triggerType.padEnd(15)} ${('$' + nb.flagged.amount.toFixed(2)).padStart(8)} ` +
      `${String(c.riskScore ?? '-').padEnd(5)} ${desc.slice(0, 51).padEnd(51)} ${String(cohort.length).padStart(6)}`,
    );
  }
}
void main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
