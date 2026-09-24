// Proves the graph is reachable through TigerGraph MCP: handshake, tool
// discovery, then a compiled GSQL query run through the protocol.
import { TigerGraphMcpClient } from '../src/tools/tigergraph-mcp-client.js';

async function main(): Promise<void> {
  const mcp = new TigerGraphMcpClient();
  console.log('connecting to the tigergraph-mcp server over stdio...');
  const tools = await mcp.connect();
  console.log(`handshake ok, ${tools.length} tools exposed`);
  const interesting = tools.filter((t) =>
    /run_installed_query|get_graph_schema|search_top_k|get_vertex_count|upsert_vectors/.test(t.name),
  );
  for (const t of interesting) console.log(`  ${t.name}`);

  console.log('\nvertex count via MCP:');
  console.log('  ' + JSON.stringify(await mcp.getVertexCount('Transaction')).slice(0, 200));

  console.log('\ncompiled GSQL query via MCP (getAccountProfile on C08623):');
  const out = await mcp.runInstalledQuery('getAccountProfile', { cust: 'C08623' });
  console.log('  ' + JSON.stringify(out).slice(0, 400));

  await mcp.close();
}
void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
