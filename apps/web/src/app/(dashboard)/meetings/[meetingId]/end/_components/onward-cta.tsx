'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, END_OF_CALL_EVENTS } from '@/lib/analytics';
import type { EndOfCallRecapState, RecapLens } from '@/lib/meetings/end-of-call-view-types';

/**
 * BAL-389 — the screen's ONE onward CTA, in the design's TWO STATES.
 *
 * ⚠⚠ THE TWO-STATE CTA IS THE DESIGN, AND ITS ONE-STATE PREDECESSOR WAS A DEPENDENCY WORKAROUND
 * THAT HAS EXPIRED. `.claude/design-references/end-of-call.jsx` draws "View recap" on a READY
 * recap and "Back to the {case}" while it is still processing. This shipped as unconditionally
 * "View recap" on an owner decision taken for ONE reason — `/cases` did not exist (BAL-421 was
 * Backlog), so the second arm would have linked nowhere. BAL-421 shipped that surface, so the
 * owner reversed the decision and the prototype's behaviour is restored. Do not re-collapse it.
 *
 * ⚠⚠ THE PROCESSING ARM IS GATED ON A **DESTINATION**, NOT ON A CONTEXT TYPE, AND THAT IS THE
 * NO-PRODUCER RULE POINTED AT A URL. `resolveCaseHref` returns `null` for every non-`case`
 * context, and a project kickoff has NO `/projects/{contextId}` page of this shape to send the
 * viewer to instead. So a null href falls back to "View recap" on BOTH recap states rather than
 * rendering a dead link or a disabled button — the recap route renders its own `processing`
 * state, so that fallback is never a 404 and never a dead end.
 *
 * ⚠ THE PROTOTYPE'S `{isCase ? 'case' : 'project'}` TERNARY COLLAPSES TO ONE ARM HERE, AND THE
 * COLLAPSE IS LOAD-BEARING RATHER THAN A SIMPLIFICATION. A non-null `caseHref` implies `isCase`
 * BY CONSTRUCTION (`resolveCaseHref` returns non-null only for the `case` context), so a
 * "project" label on this button would be UNREACHABLE code asserting a destination that does not
 * exist. The label is "Back to the case" whenever the arm renders at all.
 *
 * ⚠⚠ `?from=end_of_call` IS REQUIRED ON THE RECAP ARM, NOT DECORATION. `RecapEntrySource`
 * declares the value and `resolveEntrySource` in `meetings/[meetingId]/page.tsx` whitelists it —
 * all three edits landed in THIS ticket, because two of them ship a broken funnel dimension on
 * their own. The CASE arm carries NO `?from`, deliberately: nothing reads a `from` param on
 * `/cases/{id}` (`case_surface_viewed` has no `source` dimension), and an unread query string
 * that LOOKS like instrumentation is worse than none. Same ruling as `resolveCaseHref`'s own
 * docblock.
 *
 * ⚠ A TINY CLIENT ISLAND ON PURPOSE. `end_of_call_action` is a BROWSER event, so the CTA — and
 * nothing else in the shell — needs `'use client'`. The layout around it stays a server
 * component, and the href arrives already RESOLVED from the loader so no route-shape knowledge
 * reaches the bundle.
 *
 * ⚠ `lens` IS AN ANALYTICS **DIMENSION**, NOT A CONDITIONAL, AND IT IS SUPPLIED BY EACH
 * COMPOSITION RATHER THAN BY THE SHARED SHELL. Nothing here branches on it; both lenses render
 * the identical button to the identical destination, and BAL-421's case surface is itself
 * lens-aware, so the expert's back link is exactly as live as the client's. Threading `lens`
 * through `EndOfCallLayout` would have put it on the shared shell — precisely the shape the
 * two-composition structure exists to make impossible — so the CTA is passed IN as a slot.
 */
export function OnwardCta({
  meetingId,
  lens,
  recapState,
  caseHref,
}: Readonly<{
  meetingId: string;
  lens: RecapLens;
  recapState: EndOfCallRecapState;
  /** `/cases/{id}`, or `null` when this context has no case destination. See the docblock. */
  caseHref: string | null;
}>): React.JSX.Element {
  // ⚠ ONE DERIVED VALUE, NOT THREE PARALLEL CONDITIONALS. `caseArm` is the case href when that
  // arm applies and `null` otherwise, so the destination, the label and the tracked action are
  // all read off the SAME narrowing and cannot disagree about which button was pressed. Both
  // reasons to fall back — a ready recap, and a context with no case destination — collapse into
  // this one `null`.
  const caseArm = recapState === 'processing' ? caseHref : null;
  const action = caseArm === null ? 'view_recap' : 'back_to_case';

  const onClick = useCallback(() => {
    track(END_OF_CALL_EVENTS.ACTION, { action, lens });
  }, [action, lens]);

  return (
    <Button asChild className="min-h-12 w-full gap-2 text-sm font-semibold">
      <Link href={caseArm ?? '/meetings/' + meetingId + '?from=end_of_call'} onClick={onClick}>
        {caseArm === null ? 'View recap' : 'Back to the case'}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </Button>
  );
}
