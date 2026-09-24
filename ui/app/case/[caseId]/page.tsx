// The case view: evidence, pattern, risk, reasoning, and the recommended
// actions with an approve control on anything the permission gate routed to a
// human. The initial and final recommendations are shown side by side, since
// revising a recommendation as evidence arrives is the behaviour being graded.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { approvalsFor, getCase, recordApproval, type Action } from '@/lib/cases';

const VERDICT_STYLE: Record<string, string> = {
  fraud: 'bg-red-100 text-red-800 ring-red-200',
  legitimate: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  uncertain: 'bg-amber-100 text-amber-800 ring-amber-200',
};

const SOURCE_STYLE: Record<string, string> = {
  graph: 'bg-blue-100 text-blue-800',
  customer: 'bg-purple-100 text-purple-800',
  document: 'bg-neutral-200 text-neutral-800',
  external: 'bg-neutral-200 text-neutral-800',
};

function ActionRow({
  action,
  caseId,
  decision,
}: {
  action: Action;
  caseId: string;
  decision?: { decision: string; at: string };
}) {
  const gated = action.route !== 'auto';

  async function decide(formData: FormData): Promise<void> {
    'use server';
    const verdict = String(formData.get('decision'));
    if (verdict !== 'approved' && verdict !== 'rejected') return;
    recordApproval(caseId, action.action, action.route, verdict);
  }

  return (
    <li className="flex flex-col gap-2 border-b border-neutral-100 py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{action.action}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
              action.route === 'auto'
                ? 'bg-neutral-100 text-neutral-700'
                : action.route === 'L1'
                  ? 'bg-orange-100 text-orange-800'
                  : 'bg-red-100 text-red-800'
            }`}
          >
            {action.route === 'auto' ? 'agent may execute' : `${action.route} approval required`}
          </span>
        </div>
        <p className="mt-1 text-sm text-neutral-600">{action.reason}</p>
      </div>
      {gated ? (
        decision ? (
          <span
            className={`shrink-0 self-start rounded px-2 py-1 text-xs font-medium ${
              decision.decision === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-700'
            }`}
          >
            {decision.decision} {new Date(decision.at).toLocaleString()}
          </span>
        ) : (
          <form action={decide} className="flex shrink-0 gap-2 self-start">
            <button
              name="decision"
              value="approved"
              className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700"
            >
              Approve
            </button>
            <button
              name="decision"
              value="rejected"
              className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium hover:bg-neutral-100"
            >
              Reject
            </button>
          </form>
        )
      ) : (
        <span className="shrink-0 self-start text-xs text-neutral-400">executed</span>
      )}
    </li>
  );
}

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const answer = getCase(caseId);
  if (!answer) notFound();
  const c = answer.case;
  const decisions = approvalsFor(caseId);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/" className="text-sm text-blue-700 underline-offset-2 hover:underline">
        &larr; All cases
      </Link>

      <header className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{answer.case_id}</h1>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ${VERDICT_STYLE[c.verdict] ?? ''}`}>
          {c.verdict}
        </span>
        <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">{c.status}</span>
        {c.written_to_graph ? (
          <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-800">
            in graph as {c.graph_case_id}
          </span>
        ) : null}
      </header>

      {/* Risk and confidence */}
      <section className="mt-6 rounded-lg border border-neutral-200 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs uppercase tracking-wide text-neutral-500">Fraud probability</span>
          <span className="text-2xl font-semibold tabular-nums">{c.fraud_probability.toFixed(2)}</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-neutral-200">
          <div
            className={`h-full ${
              c.fraud_probability >= 0.7 ? 'bg-red-500' : c.fraud_probability >= 0.3 ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.round(c.fraud_probability * 100)}%` }}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-neutral-500">Pattern</div>
            <div className="font-medium">{c.pattern.replace(/_/g, ' ')}</div>
          </div>
          <div>
            <div className="text-xs text-neutral-500">Exposure</div>
            <div className="font-medium tabular-nums">${c.exposure_usd.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-neutral-500">Affected txns</div>
            <div className="font-medium tabular-nums">{c.affected_txn_ids.length}</div>
          </div>
          <div>
            <div className="text-xs text-neutral-500">Tool calls</div>
            <div className="font-medium tabular-nums">{answer.tool_calls}</div>
          </div>
        </div>
        {c.pattern_description ? (
          <p className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">{c.pattern_description}</p>
        ) : null}
      </section>

      {/* Reasoning */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Summary</h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-800">{c.summary}</p>
        <p className="mt-3 text-xs text-neutral-500">
          <span className="font-medium">Stopped because:</span> {answer.stop_reason}
        </p>
      </section>

      {/* Evidence timeline */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Evidence ({c.evidence.length})
        </h2>
        <ol className="mt-3 space-y-3">
          {c.evidence.map((e, i) => (
            <li key={i} className="rounded-lg border border-neutral-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${SOURCE_STYLE[e.source] ?? ''}`}>
                  {e.source}
                </span>
                <code className="text-[11px] text-neutral-500">{e.ref}</code>
              </div>
              <p className="mt-1.5 text-sm text-neutral-800">{e.claim}</p>
              {e.entity_ids.length > 0 ? (
                <p className="mt-1 font-mono text-[11px] text-neutral-500">
                  {e.entity_ids.slice(0, 8).join(', ')}
                  {e.entity_ids.length > 8 ? ` +${e.entity_ids.length - 8} more` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {/* Evidence requests */}
      {answer.evidence_requests.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Evidence requested</h2>
          {answer.evidence_requests.map((r, i) => (
            <div key={i} className="mt-2 rounded-lg border border-purple-200 bg-purple-50 p-3">
              <div className="text-xs font-medium text-purple-900">
                {r.type} &middot; after step {r.asked_after_step}
              </div>
              <p className="mt-1 text-sm text-purple-900">{r.assumed_response}</p>
            </div>
          ))}
        </section>
      ) : null}

      {/* Initial vs final: the graded behaviour */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Next best action</h2>
        <p className="mt-1 text-xs text-neutral-500">
          The agent recommends. Only <code className="font-mono">auto</code> actions execute themselves; L1 and
          L2 wait for a human.
        </p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-neutral-200 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Before requesting evidence
            </h3>
            <ul className="mt-1">
              {answer.next_best_actions.initial.map((a) => (
                <li key={a.action} className="border-b border-neutral-100 py-2 last:border-0">
                  <span className="font-mono text-sm">{a.action}</span>
                  <span className="ml-2 text-[11px] text-neutral-500">{a.route}</span>
                  <p className="text-xs text-neutral-600">{a.reason}</p>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border-2 border-neutral-900 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-700">After evidence</h3>
            <ul className="mt-1">
              {answer.next_best_actions.final.map((a) => (
                <ActionRow key={a.action} action={a} caseId={caseId} decision={decisions[a.action]} />
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-3 rounded bg-neutral-100 p-3 text-sm text-neutral-800">
          <span className="font-medium">What changed:</span> {answer.next_best_actions.what_changed}
        </p>
      </section>

      {/* SAR */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Suspicious activity report
        </h2>
        <div className={`mt-2 rounded-lg border p-3 ${answer.sar.file ? 'border-red-200 bg-red-50' : 'border-neutral-200'}`}>
          <div className="text-sm font-medium">{answer.sar.file ? 'Filed' : 'Not filed'}</div>
          <p className="mt-1 text-sm text-neutral-700">{answer.sar.reason}</p>
          {answer.sar.file ? (
            <>
              <p className="mt-3 text-sm leading-relaxed text-neutral-900">{answer.sar.narrative}</p>
              <p className="mt-2 text-xs text-neutral-600">
                Subjects: {answer.sar.subjects.slice(0, 6).join(', ')}
                {answer.sar.subjects.length > 6 ? ` +${answer.sar.subjects.length - 6} more` : ''} &middot; $
                {answer.sar.total_amount_usd.toFixed(2)} &middot; {answer.sar.activity_dates.join(' to ')}
              </p>
            </>
          ) : null}
        </div>
      </section>

      {/* Case memory */}
      {c.similar_prior_cases.length > 0 ? (
        <section className="mt-8 mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Prior cases used as memory
          </h2>
          <p className="mt-2 font-mono text-sm text-neutral-700">{c.similar_prior_cases.join(', ')}</p>
        </section>
      ) : null}
    </main>
  );
}
