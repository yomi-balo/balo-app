'use client';

import Link from 'next/link';
import { SectionError } from '@/components/balo/section/section-states';
import { Button } from '@/components/ui/button';

/**
 * BAL-388 — the recap's route-level ERROR boundary. Every failure resolves to a stated cause
 * plus a way forward; nothing on this page can leave the viewer stuck.
 *
 * ⚠ THE `body` OVERRIDE IS WHY `SectionError` GAINED THAT PROP. Its default reassurance line
 * is settings-shaped ("your settings are safe"), which is wrong copy on a recap.
 *
 * ⚠ NOTHING IS LOGGED HERE, MATCHING ALL 18 SIBLING BOUNDARIES. Sentry client
 * instrumentation already captures React error boundaries and `onRequestError` captures the
 * server side, so a `console.error` would add an unstructured record nothing collects — and
 * CLAUDE.md bans `console.*` in application code outside `middleware.ts` anyway.
 */
export default function RecapError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1060px] px-4 py-12 sm:px-6 lg:px-8">
      <div className="bg-card border-border rounded-2xl border p-6">
        <SectionError
          label="this recap"
          onRetry={reset}
          body="Nothing was lost — your action items and files are all still here."
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
