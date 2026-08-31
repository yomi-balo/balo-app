'use client';

import { SectionError } from '@/components/balo/section/section-states';

/**
 * BAL-498 — the Calendar route's ERROR boundary. Destructures only `reset`; the `error` prop is
 * typed but never rendered (never leak a digest to the user). No `useEffect` logging — Sentry
 * already captures boundaries and CLAUDE.md bans `console.*`. Precedent: `cases/[engagementId]/error.tsx`.
 */
export default function ExpertCalendarError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="bg-card border-border rounded-3xl border p-6">
        <SectionError
          label="your calendar"
          onRetry={reset}
          body="This might be a temporary connection issue. Your bookings are safe — try refreshing."
        />
      </div>
    </div>
  );
}
