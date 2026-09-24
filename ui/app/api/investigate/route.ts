// Proxies a live investigation to the agent backend, which runs the same
// orchestrator, policy engine and permission gate the benchmark uses.

import { NextResponse } from 'next/server';
import { AgentOfflineError, investigate } from '@/lib/agent';

export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  let body: { txnId?: string; triggerType?: string; analystNote?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  try {
    const result = await investigate({
      txnId: body.txnId ?? '',
      triggerType: body.triggerType ?? '',
      ...(body.analystNote === undefined ? {} : { analystNote: body.analystNote }),
    });
    return NextResponse.json(result);
  } catch (err) {
    const offline = err instanceof AgentOfflineError;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'the investigation failed' },
      { status: offline ? 503 : 500 },
    );
  }
}
