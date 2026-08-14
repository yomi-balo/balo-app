'use client';

import { useCallback, useState } from 'react';
import { Reveal } from '@/components/balo/engagement/reveal';
import type {
  EndOfCallRatingView,
  EndOfCallResolveView,
} from '@/lib/meetings/end-of-call-view-types';
import { RatingBlock } from './rating-block';
import { ResolvePrompt } from './resolve-prompt';

/**
 * BAL-389 — THE ORDERING RULE: **rate first, then resolve.**
 *
 * The resolve prompt appears once a rating EXISTS — given just now, or already on file. Why:
 *  · rating is asked every consultation, resolve rarely → primary before conditional;
 *  · rating is quick and revisable, resolve is consequential and one-way → cheap ask first;
 *  · if the client rates AND resolves here, the review already exists, so BAL-390's fused close
 *    email omits its review block entirely — captured in context rather than chased by email;
 *  · if they never rate, resolve never shows here. Accepted: BAL-421's case surface keeps
 *    "Mark resolved" and the 30-day sweep is the backstop.
 *
 * ⚠⚠ RATING AND RESOLVE LIVE IN **ONE** ISLAND BECAUSE THEY SHARE EXACTLY ONE PIECE OF STATE.
 * The island is the smallest thing that can own `justRated`.
 *
 * ⚠⚠ NO `router.refresh()` AFTER RATING, DELIBERATELY. The whole point of the rule is that the
 * resolve prompt appears in the SAME PAINT, in context, while the client is still here. A round
 * trip would add a network hop and a flash on a screen the user is actively abandoning. The
 * optimistic reveal is authoritative for THIS render; the server value is authoritative on every
 * subsequent load.
 *
 * ⚠⚠ THE OPTIMISTIC REVEAL IS SAFE, AND NOBODY SHOULD "HARDEN" IT INTO A SERVER ROUND TRIP.
 * `ratingExists` gates DISPLAY ONLY. The close itself passes all four of
 * `authorizeRecapCaseMutation`'s server-side gates on every call. A tampered client that flipped
 * `justRated` without rating would merely see the prompt early — and would then close a case it
 * was ALREADY entitled to close. No privilege is gained, so the ordering rule is a UX contract,
 * not a security boundary. Turning it into one would destroy the interaction for nothing.
 *
 * ⚠ THIS COMPONENT TAKES NO `lens` PROP. It is client-lens by CONSTRUCTION — the expert
 * composition never imports it — so a prop that could only ever hold one value would make
 * `end_of_call_action.lens` look like a dimension when it is a constant here.
 *
 * ⚠⚠ THE LIVE REGION IS MOUNTED **EMPTY, FROM FIRST PAINT**, AND THAT IS THE ONLY WAY IT WORKS.
 * A second consequential question appears here after the rating write — a sighted client sees it
 * slide in, but a screen-reader user heard the toast, was left in the confirmation block, and
 * was never told anything else had arrived. `aria-live` is only honoured on a region that was
 * ALREADY in the accessibility tree when its contents changed, so wrapping the conditional in a
 * live region that mounts at the same moment announces nothing at all. The wrapper is therefore
 * unconditional and the CONTENT is what is conditional. Focus is NOT moved here instead: the
 * rating block has just moved it to its own confirmation, and stealing it a second time in the
 * same beat would yank the user past the message they were reading.
 *
 * ⚠ THE GAP LIVES ON THE REVEALED BLOCK (`mt-6`), NOT ON THE COLUMN (`gap-6`). A flex `gap`
 * counts the always-mounted-but-empty live region as a child and reserves 24px of dead space
 * under the rating on every render where the prompt is absent — which is most of them.
 */
export function RateThenResolve({
  meetingId,
  rating,
  resolve,
  counterpartyName,
  noun,
}: Readonly<{
  meetingId: string;
  /** `null` when this context carries no reviewable engagement. */
  rating: EndOfCallRatingView | null;
  /** `null` on every non-`case` context — ABSENT, never disabled. */
  resolve: EndOfCallResolveView | null;
  counterpartyName: string;
  noun: string;
}>): React.JSX.Element {
  const initialRatingExists = rating !== null && rating.state.kind !== 'none';
  const [justRated, setJustRated] = useState(false);
  const onRated = useCallback(() => setJustRated(true), []);

  const ratingExists = initialRatingExists || justRated;

  return (
    <div className="flex w-full flex-col">
      {rating !== null && (
        <RatingBlock
          rating={rating}
          counterpartyName={counterpartyName}
          noun={noun}
          onRated={onRated}
        />
      )}
      <div aria-live="polite">
        {ratingExists && resolve !== null && (
          <Reveal className="border-border/60 mt-6 block w-full border-t pt-6">
            <ResolvePrompt
              meetingId={meetingId}
              resolve={resolve}
              // ⚠ ALWAYS `false` UNDER THE ORDERING RULE, and false BY DERIVATION rather than by
              // hardcoding — the prompt only mounts once a rating exists. See `ResolvePrompt`'s
              // prop docblock for why the SERVER value would be stale here.
              reviewWillBeAsked={!ratingExists}
            />
          </Reveal>
        )}
      </div>
    </div>
  );
}
