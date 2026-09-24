import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fraud Investigation Agent',
  description: 'Agentic fraud investigation and next-best-action on a TigerGraph knowledge graph',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-accent/15 text-accent ring-1 ring-accent/30">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="6" cy="7" r="2.2" />
                  <circle cx="18" cy="6" r="2.2" />
                  <circle cx="12" cy="17" r="2.2" />
                  <path d="M7.9 8.3 10.8 15M16.4 7.8 13.3 15.2M8 7.2h7.8" />
                </svg>
              </span>
              <span className="text-sm font-semibold tracking-tight">Fraud Investigation Agent</span>
            </Link>
            <nav className="ml-2 flex items-center gap-1 text-[13px]">
              <Link href="/" className="rounded-md px-2.5 py-1.5 text-ink-300 hover:bg-white/5 hover:text-ink-100">
                Queue
              </Link>
              <Link href="/new" className="rounded-md px-2.5 py-1.5 text-ink-300 hover:bg-white/5 hover:text-ink-100">
                New investigation
              </Link>
            </nav>
            <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-ink-400 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-risk-low" />
              TigerGraph &middot; 590,742 transactions
            </span>
          </div>
        </header>
        {children}
        <footer className="mx-auto max-w-7xl px-5 pb-10 pt-6 text-[11px] text-ink-400">
          The bank&apos;s model risk score is an input, never a verdict. Actions routed L1 or L2 are
          recommendations and stay unexecuted until a human approves them.
        </footer>
      </body>
    </html>
  );
}
