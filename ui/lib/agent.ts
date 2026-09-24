// Client for the agent backend in src/api/server.ts.
//
// The UI does not import the agent directly: the backend holds the loaded
// dataset in memory (about ten seconds to load) and Next's bundler cannot
// resolve the agent's NodeNext import specifiers anyway. This keeps the split
// architecture.md section 3.7 describes, with the Next app as a thin client.
//
// Start the backend with `npm run dev` in the repo root.

import 'server-only';

const API = (process.env['AGENT_API_URL'] ?? 'http://localhost:4000').replace(/\/$/, '');

export interface CustomerOption {
  readonly customerId: string;
  readonly nCards: number;
  readonly nTransactions: number;
  readonly inCasePack: boolean;
}

export interface TxnOption {
  readonly txnId: string;
  readonly ts: string;
  readonly amount: number;
  readonly channel: string;
  readonly productCd: string;
  readonly riskScore: number;
  readonly addr1: string;
  readonly hasDevice: boolean;
}

export class AgentOfflineError extends Error {
  constructor() {
    super(
      'The agent backend is not running. Start it with "npm run dev" in the repo root; it serves on port 4000.',
    );
    this.name = 'AgentOfflineError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, cache: 'no-store' });
  } catch {
    throw new AgentOfflineError();
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed with ${res.status}`);
  return body;
}

export async function isAgentUp(): Promise<boolean> {
  try {
    await call('/health');
    return true;
  } catch {
    return false;
  }
}

export async function listCustomers(query: string): Promise<readonly CustomerOption[]> {
  const body = await call<{ customers: CustomerOption[] }>(
    `/entities?kind=customers&q=${encodeURIComponent(query)}`,
  );
  return body.customers;
}

export async function listCards(customerId: string): Promise<readonly string[]> {
  const body = await call<{ cards: string[] }>(`/entities?kind=cards&customerId=${encodeURIComponent(customerId)}`);
  return body.cards;
}

export async function listTransactions(cardId: string): Promise<readonly TxnOption[]> {
  const body = await call<{ transactions: TxnOption[] }>(
    `/entities?kind=transactions&cardId=${encodeURIComponent(cardId)}`,
  );
  return body.transactions;
}

export async function investigate(input: {
  txnId: string;
  triggerType: string;
  analystNote?: string;
}): Promise<{ caseId: string }> {
  return call<{ caseId: string }>('/investigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
