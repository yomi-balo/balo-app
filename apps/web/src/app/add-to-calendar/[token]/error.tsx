'use client';

import { AlertCircle } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';

/**
 * Reached by anyone holding the email link, signed in or not — so it renders no error message
 * or digest, and offers no sign-in (a guest has no account). "Try again" is the real recovery.
 */
export default function AddToCalendarError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <BaloCard className="mx-auto w-full max-w-md p-8 text-center">
      <span className="bg-muted/40 border-border mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <AlertCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        We couldn&apos;t open this calendar link just now. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="bg-primary text-primary-foreground focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-[13.5px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
      >
        Try again
      </button>
    </BaloCard>
  );
}
