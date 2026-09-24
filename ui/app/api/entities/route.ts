// Proxies the entity pickers to the agent backend, which holds the loaded
// dataset in memory. See ui/lib/agent.ts for why the UI does not import the
// agent directly.

import { NextResponse } from 'next/server';
import { AgentOfflineError, listCards, listCustomers, listTransactions } from '@/lib/agent';

export const maxDuration = 120;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  try {
    if (kind === 'customers') {
      return NextResponse.json({ customers: await listCustomers(url.searchParams.get('q') ?? '') });
    }
    if (kind === 'cards') {
      const customerId = url.searchParams.get('customerId');
      if (customerId === null) return NextResponse.json({ error: 'customerId is required' }, { status: 400 });
      return NextResponse.json({ cards: await listCards(customerId) });
    }
    if (kind === 'transactions') {
      const cardId = url.searchParams.get('cardId');
      if (cardId === null) return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
      return NextResponse.json({ transactions: await listTransactions(cardId) });
    }
    return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
  } catch (err) {
    const offline = err instanceof AgentOfflineError;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'request failed' },
      { status: offline ? 503 : 500 },
    );
  }
}
