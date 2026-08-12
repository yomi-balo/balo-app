'use client';

import { AlertCircle } from 'lucide-react';

/**
 * BAL-132 — the lobby segment's error boundary.
 *
 * ⚠ THE `error` PROP IS ACCEPTED AND DELIBERATELY NEVER RENDERED. Next's contract requires
 * the parameter; showing its `message` or `digest` to an anonymous visitor would leak server
 * internals onto a public, unauthenticated surface. Only `reset` is destructured — the
 * sibling `/join/[token]/error.tsx` does exactly this, and for the same reason.
 *
 * ⚠ NO `void error` TO SILENCE THE UNUSED WARNING. SonarCloud S3735 flags the `void`
 * operator, and it escapes local lint. Not destructuring it is the fix.
 */
export default function LobbyError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
      <span className="bg-muted/40 border-border mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <AlertCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        We couldn&apos;t open this meeting just now. Please try again in a moment.
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
