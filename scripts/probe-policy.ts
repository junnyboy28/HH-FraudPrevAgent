// Dev probe: the permission gate and rule engine on hand-built assessments,
// checking the cases that matter most for the next-best-action score.
import { decideSar, resolveRoute, selectActions, type CaseAssessment } from '../src/orchestrator/policy-engine.js';

const base: CaseAssessment = {
  fraudProbability: 0.5, verdict: 'uncertain', pattern: 'none', exposureUsd: 0,
  singleSignal: false, customerResponse: 'not_asked', connectedToSharedOrigin: false,
  sharedOriginDescription: '', matchesRecurringPattern: false, evidenceConflicts: false,
  cardsWithConfirmedFraud: 0, clearedPurchaseAmount: 0, disputed: false,
};
const show = (label: string, a: Partial<CaseAssessment>): void => {
  const asm = { ...base, ...a };
  const acts = selectActions(asm);
  const sar = decideSar(asm);
  console.log(`\n${label}`);
  for (const x of acts) console.log(`   ${x.route.padEnd(4)} ${x.action.padEnd(24)} ${x.reason}`);
  console.log(`   SAR: ${sar.file ? 'FILE' : 'no'} (${sar.reason.slice(0, 95)})`);
};

console.log('=== BLOCK_CARD route is conditional on exposure (policy section 2) ===');
console.log(`  exposure $500   -> ${resolveRoute('BLOCK_CARD', 500)}`);
console.log(`  exposure $2500  -> ${resolveRoute('BLOCK_CARD', 2500)}`);
console.log(`  exposure $2501  -> ${resolveRoute('BLOCK_CARD', 2501)}`);
console.log(`  FILE_REPORT     -> ${resolveRoute('FILE_REPORT', 10)}`);
console.log(`  VERIFY_WITH_CUSTOMER -> ${resolveRoute('VERIFY_WITH_CUSTOMER', 10)}`);

show('R1: weak single signal, not yet asked (must NOT block)', {
  fraudProbability: 0.45, singleSignal: true, verdict: 'uncertain', exposureUsd: 128.33,
});
show('R2: customer denied, exposure $268, shared device', {
  fraudProbability: 0.86, verdict: 'fraud', customerResponse: 'denied', exposureUsd: 268.43,
  connectedToSharedOrigin: true, sharedOriginDescription: 'a device profile shared with card C00877-K1',
});
show('R2 + L2: customer denied, exposure $4,000', {
  fraudProbability: 0.9, verdict: 'fraud', customerResponse: 'denied', exposureUsd: 4000,
});
show('R3: customer confirmed', { fraudProbability: 0.4, customerResponse: 'confirmed' });
show('R7: disputed but matches recurring pattern', {
  fraudProbability: 0.35, disputed: true, matchesRecurringPattern: true, exposureUsd: 49,
});
show('R5: card testing with a $259 cleared purchase', {
  pattern: 'card_testing', fraudProbability: 0.82, verdict: 'fraud', exposureUsd: 268.43, clearedPurchaseAmount: 259.98,
});
show('R9: undocumented device ring', {
  pattern: 'undocumented', fraudProbability: 0.9, verdict: 'fraud', exposureUsd: 74.96,
  connectedToSharedOrigin: true, sharedOriginDescription: 'a device profile used by 28 cardholders',
});
show('R10: BLOCK_ALL_CARDS must be stripped with only one card compromised', {
  fraudProbability: 0.95, verdict: 'fraud', customerResponse: 'denied', exposureUsd: 9000, cardsWithConfirmedFraud: 1,
});
show('legitimate: nothing found', { fraudProbability: 0.08, verdict: 'legitimate' });
