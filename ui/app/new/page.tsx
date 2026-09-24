'use client';

// New investigation. Every input is a choice from the dataset: pick a
// cardholder, then one of their cards, then one of that card's transactions.
// Nothing is free text except the analyst note, so the agent can never be
// pointed at an entity that does not exist.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface CustomerOption {
  customerId: string;
  nCards: number;
  nTransactions: number;
  inCasePack: boolean;
}

interface TxnOption {
  txnId: string;
  ts: string;
  amount: number;
  channel: string;
  productCd: string;
  riskScore: number;
  addr1: string;
  hasDevice: boolean;
}

type Trigger = 'risk_score' | 'customer_report' | 'analyst_request';

const TRIGGERS: { id: Trigger; label: string; blurb: string }[] = [
  { id: 'risk_score', label: 'Risk signal', blurb: "The bank's model scored this transaction high." },
  { id: 'customer_report', label: 'Customer report', blurb: 'The cardholder says they did not make it.' },
  { id: 'analyst_request', label: 'Analyst request', blurb: 'A human opened this one deliberately.' },
];

export default function NewInvestigation() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [customerId, setCustomerId] = useState('');
  const [cards, setCards] = useState<string[]>([]);
  const [cardId, setCardId] = useState('');
  const [txns, setTxns] = useState<TxnOption[]>([]);
  const [txnId, setTxnId] = useState('');
  const [trigger, setTrigger] = useState<Trigger>('risk_score');
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (params: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`/api/entities?${params}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body['error'] ?? 'request failed'));
    return body;
  }, []);

  // Customers, debounced on the search box.
  useEffect(() => {
    let cancelled = false;
    setLoadingCustomers(true);
    const timer = setTimeout(() => {
      void load(`kind=customers&q=${encodeURIComponent(query)}`)
        .then((body) => {
          if (!cancelled) setCustomers((body['customers'] as CustomerOption[]) ?? []);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'could not load cardholders');
        })
        .finally(() => {
          if (!cancelled) setLoadingCustomers(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, load]);

  useEffect(() => {
    if (customerId === '') return;
    setCards([]);
    setCardId('');
    setTxns([]);
    setTxnId('');
    void load(`kind=cards&customerId=${encodeURIComponent(customerId)}`)
      .then((body) => {
        const list = (body['cards'] as string[]) ?? [];
        setCards(list);
        if (list.length === 1 && list[0] !== undefined) setCardId(list[0]);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not load cards'));
  }, [customerId, load]);

  useEffect(() => {
    if (cardId === '') return;
    setTxns([]);
    setTxnId('');
    void load(`kind=transactions&cardId=${encodeURIComponent(cardId)}`)
      .then((body) => setTxns((body['transactions'] as TxnOption[]) ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not load transactions'));
  }, [cardId, load]);

  async function run(): Promise<void> {
    setRunning(true);
    setError('');
    try {
      const res = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txnId, triggerType: trigger, analystNote: note }),
      });
      const body = (await res.json()) as { caseId?: string; error?: string };
      if (!res.ok || !body.caseId) throw new Error(body.error ?? 'the investigation failed');
      router.push(`/case/${body.caseId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'the investigation failed');
      setRunning(false);
    }
  }

  const step = txnId !== '' ? 4 : cardId !== '' ? 3 : customerId !== '' ? 2 : 1;
  const selectedTxn = txns.find((t) => t.txnId === txnId);

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <h1 className="text-xl font-semibold tracking-tight">New investigation</h1>
      <p className="mt-1 text-[13px] text-ink-300">
        Pick a real cardholder, card and transaction from the graph. The agent runs the same eight-step flow,
        policy rules and permission gate it uses on the benchmark cases.
      </p>

      {/* Step rail */}
      <div className="mt-5 flex items-center gap-1.5 text-[11px]">
        {['Cardholder', 'Card', 'Transaction', 'Trigger'].map((s, i) => (
          <div key={s} className="flex items-center gap-1.5">
            <span
              className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold ${
                step > i + 1
                  ? 'bg-risk-low/20 text-risk-low ring-1 ring-risk-low/40'
                  : step === i + 1
                    ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                    : 'bg-ink-800 text-ink-400 ring-1 ring-ink-700'
              }`}
            >
              {step > i + 1 ? '✓' : i + 1}
            </span>
            <span className={step >= i + 1 ? 'text-ink-200' : 'text-ink-400'}>{s}</span>
            {i < 3 ? <span className="mx-1 h-px w-6 bg-ink-700" /> : null}
          </div>
        ))}
      </div>

      {error ? (
        <div className="panel mt-4 border-risk-high/40 p-3 text-[12.5px] text-risk-high">{error}</div>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/* 1. Cardholder */}
        <section className="panel p-4">
          <div className="label">1 &middot; Cardholder</div>
          <input
            className="field mt-2"
            placeholder="Search customer id, e.g. C08623"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mt-2 max-h-56 overflow-y-auto">
            {loadingCustomers ? (
              <p className="py-3 text-center text-[12px] text-ink-400 pulsing">loading the graph…</p>
            ) : customers.length === 0 ? (
              <p className="py-3 text-center text-[12px] text-ink-400">no cardholder matches that id</p>
            ) : (
              customers.map((c) => (
                <button
                  key={c.customerId}
                  onClick={() => setCustomerId(c.customerId)}
                  className={`row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                    customerId === c.customerId ? 'bg-accent/10 ring-1 ring-accent/30' : ''
                  }`}
                >
                  <span className="mono text-[12.5px]">{c.customerId}</span>
                  {c.inCasePack ? <span className="pill pill-neutral">benchmark</span> : null}
                  <span className="ml-auto text-[11px] text-ink-400">
                    {c.nCards} card{c.nCards === 1 ? '' : 's'} &middot; {c.nTransactions.toLocaleString()} txns
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* 2. Card */}
        <section className="panel p-4">
          <div className="label">2 &middot; Card</div>
          {customerId === '' ? (
            <p className="mt-3 text-[12px] text-ink-400">Pick a cardholder first.</p>
          ) : cards.length === 0 ? (
            <p className="mt-3 text-[12px] text-ink-400 pulsing">loading cards…</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cards.map((id) => (
                <button
                  key={id}
                  onClick={() => setCardId(id)}
                  className={`mono rounded-md border px-2.5 py-1.5 text-[12.5px] ${
                    cardId === id ? 'border-accent/50 bg-accent/10 text-ink-100' : 'border-ink-700 text-ink-300 hover:bg-white/5'
                  }`}
                >
                  {id}
                </button>
              ))}
            </div>
          )}

          <div className="label mt-5">4 &middot; Trigger</div>
          <div className="mt-2 space-y-1.5">
            {TRIGGERS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTrigger(t.id)}
                className={`flex w-full flex-col items-start rounded-md border px-2.5 py-2 text-left ${
                  trigger === t.id ? 'border-accent/50 bg-accent/10' : 'border-ink-700 hover:bg-white/5'
                }`}
              >
                <span className="text-[12.5px] font-semibold">{t.label}</span>
                <span className="text-[11px] text-ink-400">{t.blurb}</span>
              </button>
            ))}
          </div>
          {trigger === 'analyst_request' ? (
            <input
              className="field mt-2"
              placeholder="Optional analyst note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          ) : null}
        </section>
      </div>

      {/* 3. Transaction */}
      <section className="panel mt-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-2.5">
          <div className="label">3 &middot; Transaction</div>
          {cardId !== '' ? (
            <span className="ml-auto text-[11px] text-ink-400">
              {txns.length} most recent on <span className="mono">{cardId}</span>
            </span>
          ) : null}
        </div>
        {cardId === '' ? (
          <p className="px-4 py-6 text-center text-[12px] text-ink-400">Pick a card to list its transactions.</p>
        ) : txns.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-ink-400 pulsing">loading transactions…</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {txns.map((t) => (
              <button
                key={t.txnId}
                onClick={() => setTxnId(t.txnId)}
                className={`row grid w-full grid-cols-12 items-center gap-2 border-b border-ink-800 px-4 py-2 text-left last:border-0 ${
                  txnId === t.txnId ? 'bg-accent/10' : ''
                }`}
              >
                <span className="mono col-span-3 text-[12px]">{t.txnId}</span>
                <span className="col-span-3 text-[11.5px] text-ink-300">{t.ts}</span>
                <span className="mono col-span-2 text-[12px]">${t.amount.toFixed(2)}</span>
                <span className="col-span-2 text-[11px] text-ink-400">{t.channel.replace('_', ' ')}</span>
                <span className="col-span-2 flex items-center justify-end gap-1.5">
                  {t.hasDevice ? <span className="pill pill-neutral">device</span> : null}
                  <span
                    className={`mono text-[11px] ${
                      t.riskScore >= 0.7 ? 'text-risk-high' : t.riskScore >= 0.4 ? 'text-risk-mid' : 'text-ink-400'
                    }`}
                  >
                    {t.riskScore >= 0 ? t.riskScore.toFixed(2) : '—'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Run */}
      <div className="panel mt-4 flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 text-[12px] text-ink-300">
          {selectedTxn ? (
            <>
              Investigating <span className="mono text-ink-100">{selectedTxn.txnId}</span> (
              <span className="mono">${selectedTxn.amount.toFixed(2)}</span>, {selectedTxn.channel.replace('_', ' ')})
              on <span className="mono text-ink-100">{cardId}</span> as a{' '}
              {TRIGGERS.find((t) => t.id === trigger)?.label.toLowerCase()}.
            </>
          ) : (
            'Select a transaction to enable the run.'
          )}
        </div>
        <button className="btn btn-primary ml-auto" disabled={txnId === '' || running} onClick={() => void run()}>
          {running ? 'Investigating…' : 'Run investigation'}
        </button>
      </div>
      {running ? (
        <p className="mt-2 text-[11.5px] text-ink-400 pulsing">
          Pulling the neighbourhood, timeline, shared devices and prior cases from the graph, then assessing under
          the policy. The first run in a fresh server also loads the dataset, so give it a few seconds.
        </p>
      ) : null}
    </main>
  );
}
