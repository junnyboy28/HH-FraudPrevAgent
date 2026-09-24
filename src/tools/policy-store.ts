// Reads the PolicyDoc vertices and their vectors back out of TigerGraph and
// ranks them against a case's graph evidence.
//
// This is the retrieval half of GraphRAG. The corpus lives in the graph (written
// by scripts/ingest-policy-docs.ts), the query is the evidence the graph queries
// actually returned, and what comes back is the policy text that matches what
// was found rather than whatever a keyword search would surface.
//
// If TigerGraph is unreachable the corpus is rebuilt locally from the same
// README with the same deterministic embedding, so an investigation is never
// blocked by the graph being asleep. Savanna auto-stops.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicyCorpus, cosine, embed, type PolicyChunk, type RetrievedChunk } from './graphrag.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GRAPH = 'FraudGraph';

function envVar(name: string): string {
  const file = path.join(REPO_ROOT, '.env');
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      if (line.slice(0, line.indexOf('=')).trim() === name) return line.slice(line.indexOf('=') + 1).trim();
    }
  } catch {
    return '';
  }
  return '';
}

interface VertexRow {
  readonly v_id: string;
  readonly attributes: {
    readonly source?: string;
    readonly section?: string;
    readonly title?: string;
    readonly url?: string;
    readonly text?: string;
    readonly embedding?: number[];
  };
}

export class PolicyStore {
  private corpus: PolicyChunk[] | null = null;
  private origin: 'tigergraph' | 'local' = 'local';

  constructor(
    private readonly host = envVar('TIGERGRAPH_HOST').replace(/\/$/, ''),
    private readonly secret = envVar('TIGERGRAPH_TOKEN'),
  ) {}

  /** Where the chunks came from, for the record in the case trace. */
  get source(): 'tigergraph' | 'local' {
    return this.origin;
  }

  private async token(): Promise<string> {
    const res = await fetch(`${this.host}/gsql/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.secret, lifetime: '2592000' }),
    });
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('no token');
    return body.token;
  }

  /** Loads the corpus once. Falls back to the local build if the graph is away. */
  async load(): Promise<readonly PolicyChunk[]> {
    if (this.corpus !== null) return this.corpus;
    if (this.host !== '' && this.secret !== '') {
      try {
        const tok = await this.token();
        const res = await fetch(`${this.host}/restpp/graph/${GRAPH}/vertices/PolicyDoc?limit=500`, {
          headers: { Authorization: `Bearer ${tok}` },
        });
        const body = (await res.json()) as { error?: boolean; results?: VertexRow[] };
        const rows = body.results ?? [];
        if (body.error !== true && rows.length > 0) {
          this.corpus = rows.map((r) => ({
            chunkId: r.v_id,
            source: r.attributes.source ?? '',
            section: r.attributes.section ?? '',
            title: r.attributes.title ?? '',
            url: r.attributes.url ?? '',
            text: r.attributes.text ?? '',
            // Re-embed if a vertex predates the vector attribute.
            embedding:
              r.attributes.embedding !== undefined && r.attributes.embedding.length > 0
                ? r.attributes.embedding
                : embed(`${r.attributes.title ?? ''} ${r.attributes.text ?? ''}`),
          }));
          this.origin = 'tigergraph';
          return this.corpus;
        }
      } catch {
        // fall through to the local corpus
      }
    }
    this.corpus = [...buildPolicyCorpus()];
    this.origin = 'local';
    return this.corpus;
  }

  /**
   * Top-k policy and pattern chunks for a case, ranked against the text of the
   * evidence the graph returned.
   */
  async retrieveForEvidence(evidenceText: string, topK = 4): Promise<readonly RetrievedChunk[]> {
    const corpus = await this.load();
    const query = embed(evidenceText);
    return corpus
      .map((chunk) => ({ ...chunk, score: cosine(query, chunk.embedding) }))
      .filter((c) => c.score > 0.03)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
