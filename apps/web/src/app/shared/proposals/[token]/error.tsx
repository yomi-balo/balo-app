'use client';

import { AlertCircle } from 'lucide-react';

/**
 * Error boundary for the public shared-proposal segment (BAL-386). A generic,
 * leak-free fallback — never reveals whether the proposal exists. Offers a retry.
 * The thrown error is captured by the framework's Sentry `onRequestError` hook, so
 * this boundary only renders UI (no manual logging).
 */
export default function SharedProposalError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex justify-center px-4 pt-6">
      <div className="border-border bg-card w-full max-w-md rounded-2xl border p-8 text-center">
        <span className="bg-muted/40 border-border mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
          <AlertCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="text-foreground mt-4 text-lg font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
          We couldn&apos;t open this proposal just now. Please try again in a moment.
        </p>
        <button
          type="button"
          onClick={reset}
          className="bg-primary text-primary-foreground focus-visible:ring-ring mt-5 inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-[13.5px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
