// Runs the same evidence gathering three ways and compares: local projection,
// TigerGraph over REST, TigerGraph over MCP. Identical output is the claim.
import { LocalEvidenceSource } from '../src/tools/local-evidence-source.js';
import { TigerGraphEvidenceSource } from '../src/tools/tigergraph-evidence-source.js';
import { TigerGraphMcpClient } from '../src/tools/tigergraph-mcp-client.js';

async function main(): Promise<void> {
  const mcp = new TigerGraphMcpClient();
  await mcp.connect();
  const viaMcp = new TigerGraphEvidenceSource(undefined, undefined, mcp);
  const viaRest = new TigerGraphEvidenceSource();
  const local = new LocalEvidenceSource();
  const acct = 'C13487';
  const card = 'C13487-K1';

  const row = async (label: string, f: (s: LocalEvidenceSource | TigerGraphEvidenceSource) => Promise<unknown>) => {
    const [m, r, l] = [await f(viaMcp), await f(viaRest), await f(local)];
    const ok = JSON.stringify(m) === JSON.stringify(r) && JSON.stringify(r) === JSON.stringify(l);
    console.log(`  ${label.padEnd(22)} mcp=${String(m).padEnd(8)} rest=${String(r).padEnd(8)} local=${String(l).padEnd(8)} ${ok ? 'MATCH' : 'DIFFER'}`);
  };

  console.log(`transports: viaMcp=${viaMcp.transport}  viaRest=${viaRest.transport}\n`);
  await row('profile n_txns', async (s) => (await s.getAccountProfile(acct)).nTransactions);
  await row('regions used', async (s) => (await s.getAccountProfile(acct)).regionsUsed.length);
  await row('cards', async (s) => (await s.getAccountProfile(acct)).cardIds.length);
  await row('timeline txns', async (s) => (await s.getCardTimeline(card)).length);
  await row('shared links', async (s) => (await s.findSharedDevicesAcrossAccounts(acct)).length);
  await row('fraud via device', async (s) => (await s.findLinkedFraudHistory(acct)).viaSharedDevice.length);
  await mcp.close();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
