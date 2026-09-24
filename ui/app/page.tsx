// The queue: all investigated cases, with the signal a reviewer needs first.
import Link from 'next/link';
import { listCases, type AnswerFile } from '@/lib/cases';

function verdictPill(verdict: string): string {
  return verdict === 'fraud' ? 'pill pill-fraud' : verdict === 'legitimate' ? 'pill pill-legit' : 'pill pill-uncertain';
}

function routePill(route: string): string {
  return route === 'L2' ? 'pill pill-l2' : route === 'L1' ? 'pill pill-l1' : 'pill pill-auto';
}

function riskColor(p: number): string {
  return p >= 0.7 ? 'bg-risk-high' : p >= 0.3 ? 'bg-risk-mid' : 'bg-risk-low';
}

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: string }) {
  return (
    <div className="panel p-3.5">
      <div className="label">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tracking-tight ${tone ?? ''}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div> : null}
    </div>
  );
}

function CaseRow({ c }: { c: AnswerFile }) {
  const gated = c.next_best_actions.final.filter((a) => a.route !== 'auto');
  const changed = c.next_best_actions.what_changed !== 'nothing';
  return (
    <Link
      href={`/case/${c.case_id}`}
      className="row grid grid-cols-12 items-center gap-3 border-b border-ink-800 px-4 py-3 last:border-0"
    >
      <div className="col-span-6 sm:col-span-3">
        <div className="flex items-center gap-2">
          <span className="mono text-[13px] font-semibold">{c.case_id}</span>
          <span className={verdictPill(c.case.verdict)}>{c.case.verdict}</span>
        </div>
        <div className="mt-1 truncate text-[11px] text-ink-400">
          {c.case.pattern === 'none' ? 'no documented pattern' : c.case.pattern.replace(/_/g, ' ')}
          {changed ? <span className="text-accent"> &middot; revised</span> : null}
        </div>
      </div>

      <div className="col-span-6 sm:col-span-2">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-full max-w-[84px] overflow-hidden rounded-full bg-ink-700">
            <div
              className={`h-full rounded-full ${riskColor(c.case.fraud_probability)}`}
              style={{ width: `${Math.max(3, Math.round(c.case.fraud_probability * 100))}%` }}
            />
          </div>
          <span className="mono text-[12px] text-ink-200">{c.case.fraud_probability.toFixed(2)}</span>
        </div>
      </div>

      <div className="col-span-4 hidden sm:block sm:col-span-2">
        <span className="mono text-[13px] text-ink-200">
          {c.case.exposure_usd > 0 ? `$${c.case.exposure_usd.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
        </span>
      </div>

      <div className="col-span-12 flex flex-wrap gap-1 sm:col-span-4">
        {c.next_best_actions.final.slice(0, 4).map((a) => (
          <span key={a.action} className={routePill(a.route)} title={a.reason}>
            {a.action.replace(/_/g, ' ').toLowerCase()}
            {a.route !== 'auto' ? ` · ${a.route}` : ''}
          </span>
        ))}
        {c.next_best_actions.final.length > 4 ? (
          <span className="pill pill-neutral">+{c.next_best_actions.final.length - 4}</span>
        ) : null}
      </div>

      <div className="col-span-12 flex items-center gap-2 sm:col-span-1 sm:justify-end">
        {c.sar.file ? <span className="pill pill-l2">SAR</span> : null}
        {gated.length > 0 ? <span className="pill pill-neutral">{gated.length} to approve</span> : null}
      </div>
    </Link>
  );
}

export default function Home() {
  const cases = listCases();
  const n = (v: string): number => cases.filter((c) => c.case.verdict === v).length;
  const blocked = cases.filter((c) => c.next_best_actions.final.some((a) => a.action.startsWith('BLOCK'))).length;
  const sars = cases.filter((c) => c.sar.file).length;
  const revised = cases.filter((c) => c.next_best_actions.what_changed !== 'nothing').length;
  const exposure = cases.reduce((s, c) => s + c.case.exposure_usd, 0);
  const live = cases.filter((c) => c.case_id.startsWith('LIVE-'));
  const exam = cases.filter((c) => !c.case_id.startsWith('LIVE-'));

  return (
    <main className="mx-auto max-w-7xl px-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Investigation queue</h1>
          <p className="mt-1 text-[13px] text-ink-300">
            {exam.length} benchmark cases{live.length > 0 ? ` and ${live.length} ad-hoc` : ''}, each investigated
            from the graph, assessed against the bank&apos;s fraud policy, and written back as case memory.
          </p>
        </div>
        <Link href="/new" className="btn btn-primary">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New investigation
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Fraud" value={n('fraud')} tone="text-risk-high" hint={`${blocked} cards blocked`} />
        <Stat label="Uncertain" value={n('uncertain')} tone="text-risk-mid" hint="more evidence or escalation" />
        <Stat label="Legitimate" value={n('legitimate')} tone="text-risk-low" hint="closed, no action" />
        <Stat label="Reports filed" value={sars} hint="regulatory, L2 approval" />
        <Stat
          label="Exposure identified"
          value={`$${Math.round(exposure).toLocaleString()}`}
          hint={`recommendation revised on ${revised}`}
        />
      </div>

      <div className="panel mt-6 overflow-hidden">
        <div className="hidden grid-cols-12 gap-3 border-b border-ink-800 bg-white/[0.015] px-4 py-2 sm:grid">
          <div className="label col-span-3">Case</div>
          <div className="label col-span-2">Fraud probability</div>
          <div className="label col-span-2">Exposure</div>
          <div className="label col-span-4">Recommended actions</div>
          <div className="label col-span-1 text-right">Flags</div>
        </div>
        {cases.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-ink-300">
            No cases yet. Run <code className="mono text-ink-100">npm run benchmark</code> in the repo root.
          </p>
        ) : (
          cases.map((c) => <CaseRow key={c.case_id} c={c} />)
        )}
      </div>
    </main>
  );
}
