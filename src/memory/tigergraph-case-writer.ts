// Writes a finished case back into TigerGraph as a FraudCase vertex plus its
// edges, so later investigations can retrieve it. This is the "update case
// memory" step of the 8-step flow, and it is what lets the answer file report
// written_to_graph = true with a real graph_case_id.
//
// Uses the REST upsert endpoint rather than a loading job: one case at a time,
// written as the investigation closes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnswerFile, CaseWriter } from '../orchestrator/case-orchestrator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GRAPH = 'FraudGraph';

function envVar(name: string): string {
  const raw = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    if (line.slice(0, line.indexOf('=')).trim() === name) {
      return line.slice(line.indexOf('=') + 1).trim();
    }
  }
  return '';
}

export class TigerGraphCaseWriter implements CaseWriter {
  private token: string | null = null;

  constructor(
    private readonly host = envVar('TIGERGRAPH_HOST').replace(/\/$/, ''),
    private readonly secret = envVar('TIGERGRAPH_TOKEN'),
  ) {}

  static isConfigured(): boolean {
    return envVar('TIGERGRAPH_HOST') !== '' && envVar('TIGERGRAPH_TOKEN') !== '';
  }

  private async auth(): Promise<string> {
    if (this.token !== null) return this.token;
    const res = await fetch(`${this.host}/gsql/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.secret, lifetime: '2592000' }),
    });
    const body = (await res.json()) as { token?: string; message?: string };
    if (!body.token) throw new Error(`TigerGraph auth failed: ${body.message ?? 'no token returned'}`);
    this.token = body.token;
    return body.token;
  }

  /**
   * Upserts the case and its edges in one request. The graph case id is derived
   * from the exam case id so a re-run overwrites rather than duplicating.
   */
  async writeCase(answer: AnswerFile): Promise<string> {
    const token = await this.auth();
    const graphCaseId = `CASE-2016-${answer.case_id.replace(/[^0-9]/g, '')}`;
    const c = answer.case;

    const attr = (v: string | number | boolean): { value: string | number | boolean } => ({ value: v });

    const vertices: Record<string, Record<string, Record<string, unknown>>> = {
      FraudCase: {
        [graphCaseId]: {
          source: attr('agent'),
          account_id: attr(''),
          card_id: attr(''),
          outcome: attr(c.verdict === 'fraud' ? 'confirmed_fraud' : c.verdict === 'legitimate' ? 'cleared' : ''),
          pattern: attr(c.pattern),
          first_fraud_txn_id: attr(c.first_suspicious_txn_id),
          n_txns: attr(c.affected_txn_ids.length),
          exposure_usd: attr(c.exposure_usd),
          report_filed: attr(answer.sar.file ? 'Yes' : 'No'),
          actions_taken: attr(answer.next_best_actions.final.map((a) => a.action).join('|')),
          analyst_notes: attr(c.summary),
          status: attr(c.status),
          verdict: attr(c.verdict),
          fraud_probability: attr(c.fraud_probability),
          summary: attr(c.summary),
        },
      },
    };

    const edges: Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>> = {
      FraudCase: {
        [graphCaseId]: {
          MATCHES_PATTERN: { FraudPattern: { [c.pattern]: {} } },
        },
      },
    };
    const involves: Record<string, Record<string, unknown>> = {};
    for (const txnId of c.affected_txn_ids.slice(0, 200)) involves[txnId] = {};
    if (Object.keys(involves).length > 0) {
      const entry = edges['FraudCase']?.[graphCaseId];
      if (entry) entry['INVOLVES'] = { Transaction: involves };
    }

    const res = await fetch(`${this.host}/restpp/graph/${GRAPH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vertices, edges }),
    });
    const body = (await res.json()) as { error?: boolean; message?: string };
    if (body.error === true) {
      throw new Error(`Writing case ${graphCaseId} to the graph failed: ${body.message ?? ''}`);
    }
    return graphCaseId;
  }
}
