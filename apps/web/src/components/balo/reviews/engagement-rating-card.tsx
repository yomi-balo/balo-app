'use client';

import { useEffect, useRef } from 'react';
import { Star } from 'lucide-react';
import type { ReviewEngagementKind, ReviewPromptSurface } from '@balo/analytics/events';
import { SectionHead } from '@/components/balo/section/section-states';
import { track, REVIEW_EVENTS } from '@/lib/analytics';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';
import { RatingBlock } from './rating-block';

/**
 * BAL-587 — `RatingBlock` mounted at THREE MORE placements: the project workspace (under
 * `CompletedBanner`), the case rail (in `MarkResolvedButton`'s slot), and the recap wrap-up
 * card's RESOLVED state. `end_of_call` keeps its own dedicated mount, `RateThenResolve`
 * (`meetings/[meetingId]/end/_components/rate-then-resolve.tsx`), which this card does not
 * replace.
 *
 * ⚠ THE LOADER DECIDES WHETHER THIS RENDERS AT ALL. Each of the three server loaders calls
 * `readRatingCard` and passes `rating: null` when there is nothing to show — a never-consulted
 * case, an expert or admin viewer, an open case. This component has no empty state of its own:
 * given a `rating`, it always has something to render.
 *
 * ⚠⚠ `onRated` IS A MODULE-LEVEL NO-OP, DELIBERATELY. Every other `RatingBlock` mount reveals
 * something once a rating exists (the resolve prompt, on `end_of_call`); none of these three
 * placements has anything further to reveal into — the card IS the whole feature here.
 *
 * ⚠⚠ `REVIEW_EVENTS.PROMPT_VIEWED` FIRES EXACTLY ONCE PER MOUNT, guarded by a ref rather than a
 * dependency array — a prop change (a poll, a revalidated server value) must not re-fire it.
 * Follows the pattern `request-detail-analytics.tsx` set for this exact shape.
 *
 * ⚠ `surface` IS TYPED `ReviewPromptSurface` (every in-app surface except `end_of_call`),
 * because `end_of_call` already has its own dedicated view event
 * (`END_OF_CALL_SERVER_EVENTS.VIEWED`) and must never reach this component.
 *
 * ⚠ `frame` PICKS A CONTAINER, NOT A BOOLEAN — the three placements don't share one look.
 * `'section'` is the project workspace's rounded-2xl rail card; `'rail'` matches the case rail's
 * sibling cards (`case-party-card.tsx`), a shorter radius and tighter padding; `'none'` is inline
 * with no frame, because the recap wrap-up card supplies its own border. `headingLevel={3}` is
 * passed to `RatingBlock` unconditionally, including for `'none'`, so the question is never a
 * second `h2` competing with a page's own heading.
 */
function noopOnRated(): void {
  // Nothing to reveal here — see the module docblock.
}

export function EngagementRatingCard({
  rating,
  counterpartyName,
  engagementKind,
  surface,
  frame,
}: Readonly<{
  rating: EndOfCallRatingView;
  /** The expert's given name. Never an email address. */
  counterpartyName: string;
  engagementKind: ReviewEngagementKind;
  surface: ReviewPromptSurface;
  /** Which container this mount renders — see the module docblock. */
  frame: 'none' | 'section' | 'rail';
}>): React.JSX.Element {
  const viewedFired = useRef(false);

  useEffect(() => {
    if (viewedFired.current) return;
    viewedFired.current = true;
    track(REVIEW_EVENTS.PROMPT_VIEWED, {
      surface,
      state: rating.state.kind,
      engagement_kind: engagementKind,
    });
  }, [surface, rating.state.kind, engagementKind]);

  const block = (
    <RatingBlock
      rating={rating}
      counterpartyName={counterpartyName}
      noun={engagementKind}
      surface={surface}
      onRated={noopOnRated}
      captureHeading={'How was working with ' + counterpartyName + '?'}
      headingLevel={3}
    />
  );

  if (frame === 'none') {
    return block;
  }

  const frameClassName =
    frame === 'rail'
      ? 'bg-card border-border rounded-xl border px-5 py-4'
      : 'bg-card border-border rounded-2xl border p-6';

  return (
    <section className={frameClassName}>
      <SectionHead icon={Star} title="Your rating" />
      {block}
    </section>
  );
}
