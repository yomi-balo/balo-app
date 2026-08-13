'use client';

import Link from 'next/link';
import { SectionError } from '@/components/balo/section/section-states';
import { Button } from '@/components/ui/button';

/**
 * BAL-435 — the call route's ERROR boundary.
 *
 * ⚠ IT FOLLOWS `(dashboard)/meetings/[meetingId]/error.tsx` EXACTLY: `'use client'`, destructure
 * `{ reset }` only, `SectionError` with a route-appropriate `body`, and a `min-h-11` ghost
 * `Button asChild` → `<Link>`.
 *
 * ⚠⚠ NOTHING IS LOGGED HERE, MATCHING ALL SIBLING BOUNDARIES. Sentry's client instrumentation
 * already captures React error boundaries, so a `console.error` would add an unstructured record
 * nothing collects — and CLAUDE.md bans `console.*` outside `middleware.ts` anyway.
 *
 * ⚠ THE FALLBACK LINK'S LABEL IS THE SAME STRING `back-to-context.ts` uses for a guest, so the
 * call and the recap read as one product by construction rather than by coincidence.
 */
export default function CallError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4 py-12">
      <div className="bg-card border-border w-full max-w-md rounded-2xl border p-6">
        <SectionError
          label="this call"
          onRetry={reset}
          body="Nothing is lost — your meeting, its files and its notes are all still there."
        />
        <div className="mt-4 flex justify-center">
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/dashboard">Back to your dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
