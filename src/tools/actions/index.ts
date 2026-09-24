// One file per action in the bank's fraud policy (config/permissions.json).
// The identifiers are fixed by the dataset's answer format: an action name that
// does not match one of these exactly scores zero for that case.
//
// Nothing here is called directly. Every action goes through the orchestrator's
// permission gate, which resolves its route (auto, L1 or L2) first.

export { allowTransaction } from './allow-transaction.js';
export { declineTransaction } from './decline-transaction.js';
export { monitorCard } from './monitor-card.js';
export { monitorConnectedCards } from './monitor-connected-cards.js';
export { warnCustomer } from './warn-customer.js';
export { verifyWithCustomer } from './verify-with-customer.js';
export { stepUpAuth } from './step-up-auth.js';
export { blockCard } from './block-card.js';
export { blockAllCards } from './block-all-cards.js';
export { generateReport } from './generate-report.js';
export { createCase } from './create-case.js';
export { fileReport } from './file-report.js';
export { escalateToAnalyst } from './escalate-to-analyst.js';
export { closeNoFraud } from './close-no-fraud.js';
