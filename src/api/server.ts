// Backend HTTP server for the case-view UI.
//
// It owns the loaded evidence source, which is the whole reason it exists: the
// dataset slice takes about ten seconds to load, so it is loaded once here and
// reused, rather than paid per request. The Next app is a thin client over these
// endpoints (architecture.md section 3.7).
//
// Endpoints:
//   GET  /health
//   GET  /entities?kind=customers&q=       cardholders the dataset actually holds
//   GET  /entities?kind=cards&customerId=  that cardholder's cards
//   GET  /entities?kind=transactions&cardId=
//   POST /investigate  {txnId, triggerType, analystNote?}
//
// Run with: npm run dev

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseOrchestrator, type AnswerFile } from '../orchestrator/case-orchestrator.js';
import { ClaudeNarrator } from '../llm/claude-narrator.js';
import { TemplateNarrator } from '../llm/template-narrator.js';
import { LocalEvidenceSource } from '../tools/local-evidence-source.js';
import { TigerGraphCaseWriter } from '../memory/tigergraph-case-writer.js';
import type { CasePackEntry } from '../tools/evidence-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CASES_DIR = path.join(REPO_ROOT, 'cases');
const PORT = Number(process.env['AGENT_API_PORT'] ?? 4000);

const TRIGGERS = new Set(['risk_score', 'customer_report', 'analyst_request']);

const evidence = new LocalEvidenceSource();

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // The UI is served from another port in development.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleEntities(url: URL, res: ServerResponse): Promise<void> {
  const kind = url.searchParams.get('kind');

  if (kind === 'customers') {
    const pack = await evidence.getCasePack();
    const packIds = new Set(pack.map((p) => p.customerId));
    const q = (url.searchParams.get('q') ?? '').trim().toUpperCase();
    const ids = evidence.loadedAccountIds();
    const filtered = q === '' ? [...ids] : ids.filter((id) => id.toUpperCase().includes(q));
    const matches = filtered
      // Benchmark customers first: those are the ones a reviewer recognises.
      .sort((a, b) => Number(packIds.has(b)) - Number(packIds.has(a)) || (a < b ? -1 : 1))
      .slice(0, 40);
    const customers = [];
    for (const customerId of matches) {
      const profile = await evidence.getAccountProfile(customerId);
      customers.push({
        customerId,
        nCards: profile.cardIds.length,
        nTransactions: profile.nTransactions,
        inCasePack: packIds.has(customerId),
      });
    }
    json(res, 200, { customers });
    return;
  }

  if (kind === 'cards') {
    const customerId = url.searchParams.get('customerId');
    if (customerId === null) {
      json(res, 400, { error: 'customerId is required' });
      return;
    }
    const profile = await evidence.getAccountProfile(customerId);
    json(res, 200, { cards: profile.cardIds });
    return;
  }

  if (kind === 'transactions') {
    const cardId = url.searchParams.get('cardId');
    if (cardId === null) {
      json(res, 400, { error: 'cardId is required' });
      return;
    }
    const timeline = await evidence.getCardTimeline(cardId);
    const transactions = [...timeline]
      .reverse()
      .slice(0, 60)
      .map((t) => ({
        txnId: t.txnId,
        ts: t.ts,
        amount: t.amount,
        channel: t.channel,
        productCd: t.productCd,
        riskScore: t.riskScore,
        addr1: t.addr1,
        hasDevice: t.deviceProfile !== '',
      }));
    json(res, 200, { transactions });
    return;
  }

  json(res, 400, { error: 'kind must be customers, cards or transactions' });
}

/**
 * Runs a real investigation on a transaction the analyst picked, through the
 * same orchestrator, policy engine and permission gate the benchmark uses. The
 * case id is prefixed LIVE- so an ad-hoc run is never confused with one of the
 * twenty graded cases.
 */
async function handleInvestigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { txnId?: string; triggerType?: string; analystNote?: string };
  const txnId = (body.txnId ?? '').trim();
  const triggerType = body.triggerType ?? '';
  if (txnId === '') {
    json(res, 400, { error: 'txnId is required' });
    return;
  }
  if (!TRIGGERS.has(triggerType)) {
    json(res, 400, { error: 'triggerType must be risk_score, customer_report or analyst_request' });
    return;
  }
  // Only ids that exist in the dataset can be investigated.
  if (!(await evidence.txnExists(txnId))) {
    json(res, 404, { error: `transaction ${txnId} is not in the dataset` });
    return;
  }

  const neighborhood = await evidence.getEntityNeighborhood(txnId);
  const flagged = neighborhood.flagged;
  const note = (body.analystNote ?? '').trim();
  const triggerText =
    triggerType === 'customer_report'
      ? `Customer ${flagged.accountId} message: 'I never made this $${flagged.amount.toFixed(2)} purchase. Please check my card.' Refers to ${flagged.txnId}.`
      : triggerType === 'analyst_request'
        ? note === ''
          ? `Analyst request: review transaction ${flagged.txnId} on card ${flagged.cardId} and look for related activity.`
          : `Analyst request: ${note}`
        : `Real-time model scored transaction ${flagged.txnId} ($${flagged.amount.toFixed(2)}, ${flagged.channel}) at ${flagged.riskScore}. Review and decide.`;

  const entry: CasePackEntry = {
    caseId: `LIVE-${flagged.txnId}`,
    openedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    triggerType,
    triggerText,
    flaggedTxnId: flagged.txnId,
    cardId: flagged.cardId,
    customerId: flagged.accountId,
    riskScore: triggerType === 'risk_score' ? flagged.riskScore : null,
  };

  const narrator = ClaudeNarrator.isConfigured() ? new ClaudeNarrator() : new TemplateNarrator();
  const writer = TigerGraphCaseWriter.isConfigured() ? new TigerGraphCaseWriter() : null;
  const orchestrator = new CaseOrchestrator(evidence, narrator, writer);
  const answer: AnswerFile = await orchestrator.run(entry);

  mkdirSync(CASES_DIR, { recursive: true });
  writeFileSync(path.join(CASES_DIR, `${answer.case_id}.json`), JSON.stringify(answer, null, 2) + '\n', 'utf8');
  json(res, 200, { caseId: answer.case_id, answer, trace: orchestrator.getTrace() });
}

async function main(): Promise<void> {
  console.log('loading the evidence source (this takes about ten seconds)...');
  const started = Date.now();
  await evidence.load();
  console.log(`loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') {
      json(res, 204, {});
      return;
    }
    const route = async (): Promise<void> => {
      if (url.pathname === '/health') {
        json(res, 200, { ok: true, evidence: evidence.kind });
        return;
      }
      if (url.pathname === '/entities' && req.method === 'GET') {
        await handleEntities(url, res);
        return;
      }
      if (url.pathname === '/investigate' && req.method === 'POST') {
        await handleInvestigate(req, res);
        return;
      }
      json(res, 404, { error: 'not found' });
    };
    void route().catch((err: unknown) => {
      console.error(err);
      json(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    });
  });

  server.listen(PORT, () => {
    console.log(`agent API on http://localhost:${PORT}`);
    console.log('endpoints: /health, /entities?kind=customers|cards|transactions, POST /investigate');
  });
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
