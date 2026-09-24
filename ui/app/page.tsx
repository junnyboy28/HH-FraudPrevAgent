// Case queue: all 20 investigations, for demo navigation.
import Link from 'next/link';
import { listCases } from '@/lib/cases';

const VERDICT_STYLE: Record<string, string> = {
  fraud: 'bg-red-100 text-red-800 ring-red-200',
  legitimate: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  uncertain: 'bg-amber-100 text-amber-800 ring-amber-200',
};

const ROUTE_STYLE: Record<string, string> = {
  auto: 'bg-neutral-100 text-neutral-700',
  L1: 'bg-orange-100 text-orange-800',
  L2: 'bg-red-100 text-red-800',
};

export default function Home() {
  const cases = listCases();
  const counts = cases.reduce<Record<string, number>>((acc, c) => {
    acc[c.case.verdict] = (acc[c.case.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const gated = cases.filter((c) => c.next_best_actions.final.some((a) => a.route !== 'auto')).length;
  const changed = cases.filter((c) => c.next_best_actions.what_changed !== 'nothing').length;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Fraud investigation queue</h1>
      <p className="mt-1 text-sm text-neutral-600">
        {cases.length} cases investigated on the TigerGraph fraud graph. The bank&apos;s risk score is an
        input, never a verdict.
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Fraud', counts['fraud'] ?? 0],
          ['Uncertain', counts['uncertain'] ?? 0],
          ['Legitimate', counts['legitimate'] ?? 0],
          ['Awaiting approval', gated],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-neutral-200 p-3">
            <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-neutral-500">
        Recommendation changed after requested evidence on {changed} of {cases.length} cases.
      </p>

      <div className="mt-8 overflow-hidden rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2">Case</th>
              <th className="px-4 py-2">Verdict</th>
              <th className="px-4 py-2">Prob.</th>
              <th className="px-4 py-2">Pattern</th>
              <th className="px-4 py-2 text-right">Exposure</th>
              <th className="px-4 py-2">Recommended</th>
              <th className="px-4 py-2">SAR</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {cases.map((c) => (
              <tr key={c.case_id} className="hover:bg-neutral-50">
                <td className="px-4 py-2 font-medium">
                  <Link className="text-blue-700 underline-offset-2 hover:underline" href={`/case/${c.case_id}`}>
                    {c.case_id}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ${VERDICT_STYLE[c.case.verdict] ?? ''}`}
                  >
                    {c.case.verdict}
                  </span>
                </td>
                <td className="px-4 py-2 tabular-nums">{c.case.fraud_probability.toFixed(2)}</td>
                <td className="px-4 py-2 text-neutral-700">{c.case.pattern.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {c.case.exposure_usd > 0 ? `$${c.case.exposure_usd.toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {c.next_best_actions.final.map((a) => (
                      <span
                        key={a.action}
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${ROUTE_STYLE[a.route] ?? ''}`}
                        title={a.reason}
                      >
                        {a.action}
                        {a.route !== 'auto' ? ` ${a.route}` : ''}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs">{c.sar.file ? 'filed' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cases.length === 0 ? (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No case files found. Run <code className="font-mono">npm run benchmark</code> in the repo root.
        </p>
      ) : null}
    </main>
  );
}
