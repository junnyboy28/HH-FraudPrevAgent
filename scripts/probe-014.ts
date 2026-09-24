import { LocalEvidenceSource } from '../src/tools/local-evidence-source.js';

async function main(): Promise<void> {
  const src = new LocalEvidenceSource();
  const pack = await src.getCasePack();
  const c = pack.find((x) => x.caseId === 'HHG-014');
  if (!c) throw new Error('no HHG-014');
  console.log('trigger:', c.triggerText);
  const nb = await src.getEntityNeighborhood(c.flaggedTxnId);
  console.log(`flagged ${nb.flagged.txnId} $${nb.flagged.amount} channel=${nb.flagged.channel} hasIdentity=${nb.flagged.hasIdentity}`);
  console.log(`deviceProfile="${nb.flagged.deviceProfile}" deviceNew=${nb.flagged.deviceNew} proxy="${nb.flagged.proxy}"`);
  console.log(`device-linked accounts from neighborhood: ${nb.deviceLinkedAccountIds.length}`);
  const tl = await src.getCardTimeline(c.cardId);
  const online = tl.filter((t) => t.channel === 'online');
  const withDev = tl.filter((t) => t.deviceProfile !== '');
  console.log(`timeline ${tl.length} txns, online=${online.length}, withDevice=${withDev.length}`);
  const profiles = new Map<string, number>();
  for (const t of withDev) profiles.set(t.deviceProfile, (profiles.get(t.deviceProfile) ?? 0) + 1);
  console.log(`distinct device profiles on this card: ${profiles.size}`);
  for (const [p, n] of [...profiles.entries()].slice(0, 6)) console.log(`   n=${n} "${p}"`);
  const shared = await src.findSharedDevicesAcrossAccounts(c.customerId);
  console.log(`shared links after filter: ${shared.length}`);
}
void main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
