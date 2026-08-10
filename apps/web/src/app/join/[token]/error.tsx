'use client';

import { AlertCircle } from 'lucide-react';

/**
 * Route-segment error boundary for the public guest join landing (BAL-408; CLAUDE.md
 * requires one per new segment). Generic and leak-free — it never reveals whether the
 * token, the guest row or the meeting exists, so it is indistinguishable from the "link
 * isn't active" outcome to anyone probing. The thrown error is captured by the framework's
 * Sentry `onRequestError` hook, so this boundary only renders UI.
 *
 * ⚠ `error` IS DELIBERATELY NOT RENDERED — not its message and not its `digest`. This
 * segment's props carry a token in scope; a message surfaced here would be the one place
 * an internal string could reach an unauthenticated reader.
 *
 * ⚠ NO SIGN-IN CTA, for the same reason `link-not-active.tsx` has none: a guest has no
 * account. "Try again" is the only recovery that is real for this audience.
 *
 * DRAFT COPY — pending MJ sign-off.
 */
export default function JoinLandingError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
      <span className="bg-muted/40 border-border mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <AlertCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        We couldn&apos;t open your invitation just now. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="bg-primary text-primary-foreground focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-[13.5px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
      >
        Try again
      </button>
    </div>
  );
}
