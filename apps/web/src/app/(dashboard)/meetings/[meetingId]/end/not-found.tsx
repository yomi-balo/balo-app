import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EndOfCallShell } from './_components/end-of-call-shell';

/**
 * BAL-389 — the end-of-call screen's NOT-FOUND page.
 *
 * ⚠⚠ ITS OWN FILE, AND THAT IS MANDATORY RATHER THAN TIDY. Without it, `notFound()` from this
 * segment bubbles to the RECAP's `not-found.tsx`, which says "Recap not found" — wrong copy for
 * a viewer who just left a call and never asked for a recap.
 *
 * ⚠ ONE COPY FOR EVERY DENIAL — missing, soft-deleted, unauthorised, declined, ambiguous, no
 * primary context and admin-context. It deliberately does NOT distinguish "does not exist" from
 * "you cannot see it": a distinct message would confirm the meeting exists to somebody who may
 * not read it.
 *
 * ⚠ SAME `EndOfCallShell` AS THE OTHER THREE ROUTE STATES, so a denial lands in the same box at
 * the same width in the same place on the viewport rather than snapping to the top of the page.
 */
export default function EndOfCallNotFound(): React.JSX.Element {
  return (
    <EndOfCallShell>
      <div className="bg-card border-border rounded-3xl border p-8 text-center shadow-sm">
        <span
          aria-hidden="true"
          className="bg-muted text-muted-foreground mb-4 inline-grid h-13 w-13 place-items-center rounded-xl"
        >
          <FileQuestion className="h-6 w-6" />
        </span>
        <h1 className="text-foreground text-xl font-semibold">Meeting not found</h1>
        <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
          {"This meeting doesn't exist, or you don't have access to it."}
        </p>
        <div className="mt-6 flex justify-center">
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/dashboard">Back to your dashboard</Link>
          </Button>
        </div>
      </div>
    </EndOfCallShell>
  );
}
