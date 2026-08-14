'use client';

import Link from 'next/link';
import { SectionError } from '@/components/balo/section/section-states';
import { Button } from '@/components/ui/button';
import { EndOfCallShell } from './_components/end-of-call-shell';

/**
 * BAL-389 — the end-of-call screen's route-level ERROR boundary. Every failure resolves to a
 * stated cause plus a way forward; nothing here can leave the viewer stuck.
 *
 * ⚠ THE `body` OVERRIDE MATTERS ON THIS SURFACE. `SectionError`'s default reassurance line is
 * settings-shaped ("your settings are safe"), and the ONE thing this screen exists to say is
 * that it is safe to leave — so the override says exactly that.
 *
 * ⚠ NOTHING IS LOGGED HERE, matching all sibling boundaries. Sentry client instrumentation
 * already captures React error boundaries and `onRequestError` captures the server side, so a
 * `console.error` would add an unstructured record nothing collects — and CLAUDE.md bans
 * `console.*` in application code outside `middleware.ts` anyway.
 *
 * ⚠⚠ IT RENDERS INTO `EndOfCallShell`, THE SAME BOX AS THE SKELETON AND THE LOADED CARD. It used
 * to own a top-aligned `py-12` block of its own, so a failed load did not read as "this card
 * failed" — it read as the whole page jumping, because the content snapped from the vertical
 * centre to the top of the viewport. Four states, one box.
 */
export default function EndOfCallError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <EndOfCallShell>
      <div className="bg-card border-border rounded-3xl border p-6 shadow-sm">
        <SectionError
          label="this page"
          onRetry={reset}
          body="Your session is safely wrapped up — your recap is still on its way by email."
        />
        <div className="mt-4 flex justify-center">
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/dashboard">Back to your dashboard</Link>
          </Button>
        </div>
      </div>
    </EndOfCallShell>
  );
}
