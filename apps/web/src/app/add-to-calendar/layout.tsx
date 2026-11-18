import type { Metadata } from 'next';

interface AddToCalendarLayoutProps {
  children: React.ReactNode;
}

/**
 * The calendar invite email's "Add to calendar" landing. `no-referrer` because the URL carries the
 * signed event (counterparty name, member call URL) and every action here leaves for a third-party
 * calendar — the same reasoning as `app/join/layout.tsx`, whose chrome this mirrors.
 */
export const metadata: Metadata = {
  referrer: 'no-referrer',
};

export default function AddToCalendarLayout({
  children,
}: Readonly<AddToCalendarLayoutProps>): React.JSX.Element {
  return (
    <div className="bg-background relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <div className="bg-primary/10 dark:bg-primary/25 absolute -top-40 left-1/2 h-[420px] w-[680px] max-w-[140vw] -translate-x-1/2 rounded-full blur-3xl" />
      </div>
      <main className="relative z-10 mx-auto w-full max-w-[560px] px-4 py-10 sm:py-16">
        {children}
      </main>
    </div>
  );
}
