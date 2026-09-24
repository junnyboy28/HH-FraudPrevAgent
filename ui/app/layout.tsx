import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fraud Investigation Case View',
  description: 'Case view for the agentic fraud investigation agent',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
