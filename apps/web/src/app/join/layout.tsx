import type { Metadata } from 'next';

interface JoinLayoutProps {
  children: React.ReactNode;
}

/**
 * ⚠ `referrer: 'no-referrer'` IS THE POINT OF THIS FILE, not decoration (BAL-408 /
 * ADR-1044) — verbatim the `/review` layout's rationale, with one aggravating factor.
 *
 * `/join/{token}` carries a bearer token IN THE PATH. Without a strict referrer policy
 * every outbound navigation from this page — a webfont, an analytics beacon, any link a
 * later revision adds — would ship the whole token in the `Referer` header, landing it in
 * request logs and in PostHog's `$referrer` on a DIFFERENT page, where the `/join/` path
 * redaction (`@balo/shared/redaction`) cannot reach it.
 *
 * ⚠ THE AGGRAVATING FACTOR: a guest join token is deliberately **NOT single-use**. A guest
 * presents it from a desktop, then a phone, then AGAIN to rejoin after a network drop
 * mid-call. So a single leaked copy is not a spent credential — it stays replayable for the
 * whole 7-day window (`GUEST_TOKEN_TTL_AFTER_END_MS`). Set at the layout so every child
 * route inherits it (children override only title/robots). `layout.test.tsx` asserts it.
 */
export const metadata: Metadata = {
  referrer: 'no-referrer',
};

/**
 * The public shell for the guest join surfaces. No dashboard chrome and no auth — the
 * recipient is by definition not a Balo user and arrived from an email. Geist + the theme
 * tokens come from the root layout; this supplies a narrow, centred frame and the design's
 * single top-centre primary wash (deliberately more saturated in dark, per the UI skill).
 */
export default function JoinLayout({ children }: Readonly<JoinLayoutProps>): React.JSX.Element {
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
