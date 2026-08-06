import type { Metadata } from 'next';

interface ReviewLayoutProps {
  children: React.ReactNode;
}

/**
 * ⚠ `referrer: 'no-referrer'` IS THE POINT OF THIS FILE, not decoration (BAL-390 §6.2).
 *
 * `/review/{token}` carries a bearer token IN THE PATH. Without a strict referrer policy
 * every outbound navigation from this page — the "Sign in to see the engagement" link on
 * the success state, a webfont, an analytics beacon — would ship the whole token in the
 * `Referer` header, landing it in request logs and in PostHog's `$referrer` on a
 * DIFFERENT page, where the `/review/` path redaction cannot reach it. Set at the layout
 * so every child route inherits it (children override only title/robots).
 * `layout.test.tsx` asserts it.
 */
export const metadata: Metadata = {
  referrer: 'no-referrer',
};

/**
 * The public shell for the magic-link review surfaces. No dashboard chrome and no auth —
 * the recipient is logged out and arrived from an email. Geist + the theme tokens come
 * from the root layout; this supplies a narrow, centred frame and the design's single
 * top-centre primary wash (deliberately more saturated in dark, per the UI skill).
 */
export default function ReviewLayout({ children }: Readonly<ReviewLayoutProps>): React.JSX.Element {
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
