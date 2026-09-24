// Cross-checks the TigerGraph evidence source against the local one on a known
// case, so a swap of backends is a measured change and not a hope.
import { LocalEvidenceSource } from '../src/tools/local-evidence-source.js';
import { TigerGraphEvidenceSource } from '../src/tools/tigergraph-evidence-source.js';

async function main(): Promise<void> {
  const tg = new TigerGraphEvidenceSource();
  const local = new LocalEvidenceSource();
  const txn = '3478561';   // HHG-014, the device ring
  const card = 'C13487-K1';
  const acct = 'C13487';

  const [tgNb, lcNb] = [await tg.getEntityNeighborhood(txn), await local.getEntityNeighborhood(txn)];
  console.log('neighbourhood      tigergraph                     local');
  console.log('  card             ' + tgNb.cardId.padEnd(30) + lcNb.cardId);
  console.log('  account          ' + tgNb.accountId.padEnd(30) + lcNb.accountId);
  console.log('  amount           ' + String(tgNb.flagged.amount).padEnd(30) + lcNb.flagged.amount);
  console.log('  channel          ' + tgNb.flagged.channel.padEnd(30) + lcNb.flagged.channel);
  console.log('  device           ' + (tgNb.deviceProfile.slice(0,28)||'-').padEnd(30) + (lcNb.deviceProfile.slice(0,28)||'-'));

  const [tgTl, lcTl] = [await tg.getCardTimeline(card), await local.getCardTimeline(card)];
  console.log('  timeline txns    ' + String(tgTl.length).padEnd(30) + lcTl.length);

  const [tgP, lcP] = [await tg.getAccountProfile(acct), await local.getAccountProfile(acct)];
  console.log('  profile n_txns   ' + String(tgP.nTransactions).padEnd(30) + lcP.nTransactions);
  console.log('  regions used     ' + String(tgP.regionsUsed.length).padEnd(30) + lcP.regionsUsed.length);

  const [tgS, lcS] = [await tg.findSharedDevicesAcrossAccounts(acct), await local.findSharedDevicesAcrossAccounts(acct)];
  console.log('  shared links     ' + String(tgS.length).padEnd(30) + lcS.length);

  const [tgF, lcF] = [await tg.findLinkedFraudHistory(acct), await local.findLinkedFraudHistory(acct)];
  console.log('  fraud direct     ' + String(tgF.direct.length).padEnd(30) + lcF.direct.length);
  console.log('  fraud via device ' + String(tgF.viaSharedDevice.length).padEnd(30) + lcF.viaSharedDevice.length);

  const cohortTg = await tg.getDeviceCohort(tgNb.deviceProfile, tgNb.flagged.ts, 30);
  const cohortLc = await local.getDeviceCohort(lcNb.deviceProfile, lcNb.flagged.ts, 30);
  console.log('  device cohort    ' + String(cohortTg.length).padEnd(30) + cohortLc.length);
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
