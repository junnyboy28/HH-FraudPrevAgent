// The case view. Ordered the way an analyst reads a case: what it is, how
// confident we are, what the evidence was, what we recommended before and after
// asking for more, and what needs a human signature.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { approvalsFor, getCase, recordApproval, type Action } from '@/lib/cases';

function routePill(route: string): string {
  return route === 'L2' ? 'pill pill-l2' : route === 'L1' ? 'pill pill-l1' : 'pill pill-auto';
}

function sourcePill(source: string): string {
  return source === 'customer' ? 'pill pill-uncertain' : source === 'graph' ? 'pill pill-neutral' : 'pill pill-neutral';
}

function ActionItem({
  action,
  caseId,
  decision,
}: {
  action: Action;
  caseId: string;
  decision?: { decision: string; at: string };
}) {
  const gated = action.route !== 'auto';
  const rule = /\b(R\d{1,2})\b/.exec(action.reason)?.[1];

  async function decide(formData: FormData): Promise<void> {
    'use server';
    const verdict = String(formData.get('decision'));
    if (verdict !== 'approved' && verdict !== 'rejected') return;
    recordApproval(caseId, action.action, action.route, verdict);
  }

  return (
    <li className="border-b border-ink-800 px-3.5 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[13px] font-semibold">{action.action}</span>
        <span className={routePill(action.route)}>
          {action.route === 'auto' ? 'agent executes' : `${action.route} approval`}
        </span>
        {rule ? <span className="pill pill-neutral">{rule}</span> : null}
        {gated ? (
          decision ? (
            <span
              className={`pill ${decision.decision === 'approved' ? 'pill-legit' : 'pill-neutral'} ml-auto`}
              title={new Date(decision.at).toLocaleString()}
            >
              {decision.decision}
            </span>
          ) : (
            <form action={decide} className="ml-auto flex gap-1.5">
              <button name="decision" value="approved" className="btn btn-approve !px-2.5 !py-1 !text-[12px]">
                Approve
              </button>
              <button name="decision" value="rejected" className="btn btn-ghost !px-2.5 !py-1 !text-[12px]">
                Reject
              </button>
            </form>
          )
        ) : (
          <span className="ml-auto text-[11px] text-ink-400">executed</span>
        )}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">{action.reason}</p>
    </li>
  );
}

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const answer = getCase(caseId);
  if (!answer) notFound();
  const c = answer.case;
  const decisions = approvalsFor(caseId);
  const pct = Math.round(c.fraud_probability * 100);
  const riskColor = c.fraud_probability >= 0.7 ? 'text-risk-high' : c.fraud_probability >= 0.3 ? 'text-risk-mid' : 'text-risk-low';
  const riskBg = c.fraud_probability >= 0.7 ? 'bg-risk-high' : c.fraud_probability >= 0.3 ? 'bg-risk-mid' : 'bg-risk-low';
  const before = new Set(answer.next_best_actions.initial.map((a) => a.action));
  const added = answer.next_best_actions.final.filter((a) => !before.has(a.action)).map((a) => a.action);

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <Link href="/" className="text-[12px] text-ink-400 hover:text-ink-200">
        &larr; Queue
      </Link>

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <h1 className="mono text-xl font-semibold tracking-tight">{answer.case_id}</h1>
        <span className={c.verdict === 'fraud' ? 'pill pill-fraud' : c.verdict === 'legitimate' ? 'pill pill-legit' : 'pill pill-uncertain'}>
          {c.verdict}
        </span>
        <span className="pill pill-neutral">{c.status.replace(/_/g, ' ')}</span>
        {c.written_to_graph ? (
          <span className="pill pill-neutral" title="Written back to TigerGraph as case memory">
            graph: {c.graph_case_id}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-ink-400">
          {answer.tool_calls} graph calls &middot; {answer.tokens.toLocaleString()} tokens &middot; {answer.latency_s}s
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {/* Risk */}
        <section className="panel p-4 lg:col-span-1">
          <div className="label">Fraud probability</div>
          <div className="mt-2 flex items-end gap-2">
            <span className={`text-4xl font-semibold tracking-tight ${riskColor}`}>{c.fraud_probability.toFixed(2)}</span>
            <span className="pb-1.5 text-[11px] text-ink-400">{pct}%</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div className={`h-full rounded-full ${riskBg}`} style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-ink-400">
            <span>0.15 clear</span>
            <span>0.70 act</span>
            <span>0.85 stop</span>
          </div>

          <dl className="mt-4 space-y-2.5 text-[12.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-400">Pattern</dt>
              <dd className="text-right">{c.pattern === 'none' ? 'none identified' : c.pattern.replace(/_/g, ' ')}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-400">Exposure</dt>
              <dd className="mono">${c.exposure_usd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-400">Transactions</dt>
              <dd className="mono">{c.affected_txn_ids.length}</dd>
            </div>
            {c.first_suspicious_txn_id ? (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-400">First suspicious</dt>
                <dd className="mono text-[11.5px]">{c.first_suspicious_txn_id}</dd>
              </div>
            ) : null}
            {c.connected_card_ids.length > 0 ? (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-400">Connected cards</dt>
                <dd className="mono">{c.connected_card_ids.length}</dd>
              </div>
            ) : null}
          </dl>

          {c.connected_device_profiles.length > 0 ? (
            <div className="mt-4">
              <div className="label">Device profile</div>
              {c.connected_device_profiles.map((d) => (
                <p key={d} className="mono mt-1 break-words text-[11px] leading-relaxed text-ink-300">
                  {d}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        {/* Summary + pattern description */}
        <section className="panel p-4 lg:col-span-2">
          <div className="label">Analyst summary</div>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-100">{c.summary}</p>

          {c.pattern_description ? (
            <div className="panel-quiet mt-4 p-3">
              <div className="label" style={{ color: 'var(--color-risk-mid)' }}>
                Undocumented pattern
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-200">{c.pattern_description}</p>
            </div>
          ) : null}

          <div className="panel-quiet mt-4 p-3">
            <div className="label">Why the investigation stopped</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-300">{answer.stop_reason}</p>
          </div>

          {c.similar_prior_cases.length > 0 ? (
            <div className="mt-4">
              <div className="label">Prior cases retrieved as memory</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.similar_prior_cases.map((id) => (
                  <span key={id} className="pill pill-neutral mono">
                    {id}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {/* Next best action: initial vs final */}
      <section className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Next best action</h2>
          <span className="text-[11px] text-ink-400">
            the agent recommends; L1 and L2 wait for a human signature
          </span>
        </div>

        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div className="panel-quiet overflow-hidden">
            <div className="border-b border-ink-800 px-3.5 py-2">
              <div className="label">Before requesting evidence</div>
            </div>
            <ul>
              {answer.next_best_actions.initial.map((a) => (
                <li key={a.action} className="border-b border-ink-800 px-3.5 py-2.5 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono text-[12.5px]">{a.action}</span>
                    <span className={routePill(a.route)}>{a.route}</span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-400">{a.reason}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel overflow-hidden ring-1 ring-accent/25">
            <div className="flex items-center gap-2 border-b border-ink-800 px-3.5 py-2">
              <div className="label" style={{ color: 'var(--color-accent)' }}>
                After evidence
              </div>
              {added.length > 0 ? (
                <span className="pill pill-neutral ml-auto">+{added.length} new</span>
              ) : null}
            </div>
            <ul>
              {answer.next_best_actions.final.map((a) => (
                <ActionItem key={a.action} action={a} caseId={caseId} decision={decisions[a.action]} />
              ))}
            </ul>
          </div>
        </div>

        <div className="panel-quiet mt-3 flex gap-2.5 p-3">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 12h12M12 6l6 6-6 6" />
          </svg>
          <p className="text-[12.5px] leading-relaxed text-ink-200">
            <span className="font-semibold text-ink-100">What changed: </span>
            {answer.next_best_actions.what_changed}
          </p>
        </div>
      </section>

      {/* Evidence requests */}
      {answer.evidence_requests.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-[15px] font-semibold tracking-tight">Evidence requested</h2>
          {answer.evidence_requests.map((r, i) => (
            <div key={i} className="panel-quiet mt-2 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill pill-uncertain">{r.type.replace(/_/g, ' ')}</span>
                <span className="text-[11px] text-ink-400">asked after step {r.asked_after_step}</span>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-200">{r.assumed_response}</p>
            </div>
          ))}
        </section>
      ) : null}

      {/* Evidence */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">Evidence</h2>
          <span className="text-[11px] text-ink-400">{c.evidence.length} findings, each traced to its query</span>
        </div>
        <ol className="mt-3 space-y-2">
          {c.evidence.map((e, i) => (
            <li key={i} className="panel-quiet p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-ink-800 text-[10px] text-ink-300 ring-1 ring-ink-700">
                  {i + 1}
                </span>
                <span className={sourcePill(e.source)}>{e.source}</span>
                <code className="mono text-[10.5px] text-ink-400">{e.ref}</code>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-100">{e.claim}</p>
              {e.entity_ids.length > 0 ? (
                <p className="mono mt-1.5 break-words text-[10.5px] text-ink-400">
                  {e.entity_ids.slice(0, 10).join('  ')}
                  {e.entity_ids.length > 10 ? `  +${e.entity_ids.length - 10}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {/* SAR */}
      <section className="mt-6 mb-10">
        <h2 className="text-[15px] font-semibold tracking-tight">Suspicious activity report</h2>
        <div className={`panel mt-3 p-4 ${answer.sar.file ? 'ring-1 ring-risk-high/25' : ''}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={answer.sar.file ? 'pill pill-l2' : 'pill pill-neutral'}>
              {answer.sar.file ? 'filed with the regulator' : 'not filed'}
            </span>
            {answer.sar.file ? (
              <span className="mono text-[11px] text-ink-400">
                ${answer.sar.total_amount_usd.toLocaleString(undefined, { minimumFractionDigits: 2 })} &middot;{' '}
                {answer.sar.activity_dates.join(' to ')}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-300">{answer.sar.reason}</p>
          {answer.sar.file ? (
            <>
              <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-ink-100">
                {answer.sar.narrative}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {answer.sar.subjects.slice(0, 8).map((s) => (
                  <span key={s} className="pill pill-neutral mono">
                    {s.length > 28 ? `${s.slice(0, 28)}…` : s}
                  </span>
                ))}
                {answer.sar.subjects.length > 8 ? (
                  <span className="pill pill-neutral">+{answer.sar.subjects.length - 8}</span>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
