// GraphRAG: policy and pattern retrieval over PolicyDoc vertices stored in
// TigerGraph, with their embeddings.
//
// What is retrieved is deliberately narrow. Transactional evidence comes from
// the graph queries, so this layer only covers the text a human analyst would
// reach for: the bank's fraud policy (rules R1 to R10, the SAR criteria, the
// stopping criteria), the five documented pattern definitions, and the
// regulatory references. That is architecture.md section 3.2's "cut candidate"
// note made concrete: no general-purpose RAG over the dataset.
//
// Retrieval is triggered per case, not per query: the assembled graph evidence
// becomes the query text, so the policy that comes back is the policy that
// matches what was actually found. That is the "graph" half of GraphRAG.
//
// Embeddings are computed locally (hashed bag-of-words, L2-normalised) rather
// than through a hosted embedding API. The corpus is small and fixed, the
// vocabulary is domain-specific, and it keeps the pipeline free and offline.
// The vectors live on the PolicyDoc vertices in TigerGraph, which is where the
// brief asks vector storage to be.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Dimensions of the hashed embedding. Small enough to store, wide enough to separate 40-odd chunks. */
export const EMBEDDING_DIM = 256;

/** Words carrying no discriminating power in this corpus. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'this', 'for', 'on', 'with',
  'as', 'by', 'at', 'from', 'be', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'no', 'but',
  'if', 'then', 'than', 'when', 'which', 'you', 'your', 'its', 'their', 'they', 'we', 'can', 'may',
  'will', 'would', 'should', 'must', 'do', 'does', 'did', 'so', 'any', 'all', 'one', 'two', 'more',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** FNV-1a, so the same term always lands in the same dimension across processes. */
function hashTerm(term: string): number {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBEDDING_DIM;
}

/** Hashed bag-of-words with sublinear term weighting, L2-normalised. */
export function embed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const [term, count] of counts) {
    const d = hashTerm(term);
    vec[d] = (vec[d] ?? 0) + 1 + Math.log(count);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface PolicyChunk {
  readonly chunkId: string;
  /** fraud_policy, pattern_doc or regulatory. */
  readonly source: string;
  readonly section: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly embedding: readonly number[];
}

export interface RetrievedChunk extends PolicyChunk {
  readonly score: number;
}

/**
 * Splits the dataset README's policy and pattern sections into retrievable
 * chunks. Each policy rule becomes its own chunk so a retrieved chunk maps to
 * exactly one citable rule id.
 */
export function buildPolicyCorpus(): readonly PolicyChunk[] {
  const readme = readFileSync(path.join(REPO_ROOT, 'data', 'HHGOA_IEEE', 'README.md'), 'utf8');
  const chunks: PolicyChunk[] = [];

  const push = (chunkId: string, source: string, section: string, title: string, text: string, url = ''): void => {
    const trimmed = text.trim();
    if (trimmed.length < 40) return;
    chunks.push({ chunkId, source, section, title, url, text: trimmed, embedding: embed(`${title} ${trimmed}`) });
  };

  // Policy rules R1 to R10, one chunk each.
  const ruleRe = /\*\*(R\d{1,2})\.\s*([^*]+)\*\*\s*([\s\S]*?)(?=\n\*\*R\d{1,2}\.|\n### |\n## )/g;
  for (const m of readme.matchAll(ruleRe)) {
    const [, id, title, body] = m;
    if (id === undefined || title === undefined || body === undefined) continue;
    push(`policy-${id}`, 'fraud_policy', id, title.trim(), body);
  }

  // The five documented patterns, one chunk each.
  const patternRe = /\*\*(\d)\.\s*([^*]+?)\.\*\*\s*([\s\S]*?)(?=\n\*\*\d\.|\n## )/g;
  const patternIds = [
    'card_testing',
    'card_not_present_fraud',
    'card_not_present_new_device',
    'out_of_region_use',
    'account_takeover',
  ];
  for (const m of readme.matchAll(patternRe)) {
    const [, num, title, body] = m;
    if (num === undefined || title === undefined || body === undefined) continue;
    const idx = Number(num) - 1;
    const patternId = patternIds[idx];
    if (patternId === undefined) continue;
    push(`pattern-${patternId}`, 'pattern_doc', patternId, title.trim(), body);
  }

  // The named policy sections: actions, routing, case vs report, exposure,
  // evidence gathering, stopping, explaining.
  const sectionRe = /\n### (\d[a-z]?)\.\s*([^\n]+)\n([\s\S]*?)(?=\n### |\n# |\n---)/g;
  for (const m of readme.matchAll(sectionRe)) {
    const [, num, title, body] = m;
    if (num === undefined || title === undefined || body === undefined) continue;
    push(`policy-section-${num}`, 'fraud_policy', `section ${num}`, title.trim(), body);
  }

  // Regulatory references, as one chunk per regulator.
  const regRe = /\*\*(FinCEN[^*]*|FATF|FFIEC|OFAC)\*\*\s*([\s\S]*?)(?=\n\*\*[A-Z]|\n## )/g;
  for (const m of readme.matchAll(regRe)) {
    const [, body] = [m[0], m[2]];
    const name = m[1];
    if (name === undefined || body === undefined) continue;
    push(`regulatory-${name.split(' ')[0]?.toLowerCase() ?? 'ref'}`, 'regulatory', name, name, body);
  }

  return chunks;
}

/**
 * Retrieves the policy and pattern text most relevant to what the graph found.
 * The query is built from the case's own evidence, so this is retrieval grounded
 * by the graph rather than by the user's words.
 */
export function retrieve(
  corpus: readonly PolicyChunk[],
  evidenceText: string,
  topK = 4,
): readonly RetrievedChunk[] {
  const query = embed(evidenceText);
  return corpus
    .map((chunk) => ({ ...chunk, score: cosine(query, chunk.embedding) }))
    .filter((c) => c.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
