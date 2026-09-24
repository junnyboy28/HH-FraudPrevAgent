// Chunks the bank's fraud policy, the five pattern definitions and the
// regulatory references out of the dataset README, embeds each chunk, and
// writes them into TigerGraph as PolicyDoc vertices with their vectors.
//
// One-time ingestion. Run after the schema and data load:
//   npm run ingest:policy
//
// The vectors live on the vertices, so the graph holds both the connected
// evidence and the document context the agent is grounded in.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicyCorpus } from '../src/tools/graphrag.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const GRAPH = 'FraudGraph';

function env(name: string): string {
  const raw = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    if (line.slice(0, line.indexOf('=')).trim() === name) return line.slice(line.indexOf('=') + 1).trim();
  }
  throw new Error(`${name} is not set in .env`);
}

const HOST = env('TIGERGRAPH_HOST').replace(/\/$/, '');
const SECRET = env('TIGERGRAPH_TOKEN');

async function token(): Promise<string> {
  const res = await fetch(`${HOST}/gsql/v1/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, lifetime: '2592000' }),
  });
  const body = (await res.json()) as { token?: string; message?: string };
  if (!body.token) throw new Error(body.message ?? 'no token');
  return body.token;
}

async function main(): Promise<void> {
  const corpus = buildPolicyCorpus();
  if (corpus.length === 0) throw new Error('no policy chunks parsed from the dataset README');

  const bySource = new Map<string, number>();
  for (const c of corpus) bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
  console.log(`parsed ${corpus.length} chunks from the dataset README`);
  for (const [source, n] of bySource) console.log(`  ${source}: ${n}`);

  const tok = await token();
  const attr = (v: string | number | readonly number[]): { value: string | number | readonly number[] } => ({ value: v });

  const vertices: Record<string, Record<string, Record<string, unknown>>> = { PolicyDoc: {} };
  const policyDocs = vertices['PolicyDoc'];
  if (policyDocs === undefined) throw new Error('unreachable');
  for (const c of corpus) {
    policyDocs[c.chunkId] = {
      source: attr(c.source),
      section: attr(c.section),
      title: attr(c.title),
      url: attr(c.url),
      // The loader truncates nothing, but keep chunks a sane size for the LLM.
      text: attr(c.text.slice(0, 4000)),
      embedding: attr([...c.embedding]),
      n_terms: attr(c.text.split(/\s+/).length),
    };
  }

  const res = await fetch(`${HOST}/restpp/graph/${GRAPH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vertices }),
  });
  const body = (await res.json()) as { error?: boolean; message?: string; results?: unknown };
  if (body.error === true) throw new Error(`upsert failed: ${body.message ?? ''}`);
  console.log(`\nwrote ${corpus.length} PolicyDoc vertices with ${corpus[0]?.embedding.length ?? 0}-dimension vectors`);

  // Confirm what actually landed.
  const count = await fetch(`${HOST}/restpp/builtins/${GRAPH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ function: 'stat_vertex_number', type: 'PolicyDoc' }),
  });
  const counted = (await count.json()) as { results?: { v_type: string; count: number }[] };
  for (const r of counted.results ?? []) console.log(`graph now holds ${r.count} ${r.v_type} vertices`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
