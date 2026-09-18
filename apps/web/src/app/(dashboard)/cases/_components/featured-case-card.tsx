'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { ArrowRight, Clock, ListChecks, MessageSquare, Video } from 'lucide-react';
import { cn } from '@/lib/utils';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { joinAffordanceAriaLabel } from '@/lib/calendar/join-window';
import {
  formatCaseBooking,
  resolveFeaturedTiming,
  splitProductTags,
  CASE_TAGS_SHOWN,
  type FeaturedTiming,
} from '../_lib/cases-index-presentation';
import {
  CASES_INDEX_FEATURED_EYEBROW,
  CASES_INDEX_JOIN,
  CASES_INDEX_JOIN_HINT,
  CASES_INDEX_OPEN_CASE,
  CASES_INDEX_UNREAD,
  casesIndexHeldCount,
  casesIndexItemsForYou,
} from '../_lib/cases-index-copy';
import { CaseCounterpartyLine } from './case-counterparty-line';
import { CaseTrail } from './case-trail';
import type { CasesIndexCardView } from '../_lib/cases-index-view-types';
import type { CasesIndexClickHandler, CasesIndexClickReporter } from './cases-index-click';

/**
 * BAL-567 — the FEATURED case: the soonest booked consultation, drawn as a ticket with a
 * perforated stub.
 *
 * ⚠⚠ THIS IS THE ONLY CARD THAT RENDERS JOIN, and only inside the window. `joinPath` is `null`
 * on every other card (the builder never puts one there), so a second Join is not merely
 * unstyled — it has nothing to navigate to.
 *
 * ⚠⚠ JOIN IS A `<button>` + `globalThis.location.assign`, NEVER AN `href`. See
 * `JoinMeetingButton`'s docblock for why the meeting id must not become a DOM attribute, and
 * `invariants/join-link-never-writes.test.ts` for the scan that keeps it that way.
 *
 * ⚠ THE STUB TURNS GREEN AT THE SAME INSTANT JOIN APPEARS. Both read one `resolveFeaturedTiming`
 * result, so the card can never look live while offering no way in, or vice versa. Outside the
 * window the stub is indigo and states WHEN Join appears — an honest fact, not a dead button.
 *
 * ⚠ NULL-CLOCK FIRST PAINT. `clock` is `null` until `useViewerClock` has the browser's zone, so
 * the ticket renders its identity half and holds the stub's time back rather than printing a
 * server-zone time that would then move. Same posture as the dashboard Up next row.
 */

interface FeaturedCaseCardProps {
  readonly card: CasesIndexCardView;
  readonly now: Date | null;
  readonly timeZone: string | null;
  readonly onTrack: CasesIndexClickReporter;
}

export function FeaturedCaseCard({
  card,
  now,
  timeZone,
  onTrack,
}: Readonly<FeaturedCaseCardProps>): React.JSX.Element {
  const timing: FeaturedTiming | null = now === null ? null : resolveFeaturedTiming(card, now);
  const live = timing?.joinVisible ?? false;
  const booking =
    now === null ||
    timeZone === null ||
    card.nextBookingStartIso === null ||
    card.nextBookingEndIso === null
      ? null
      : formatCaseBooking(card.nextBookingStartIso, card.nextBookingEndIso, now, timeZone);
  const tags = splitProductTags(card.productTags, CASE_TAGS_SHOWN.comfortable + 1);

  // The card binds itself once — see `CaseCard` for the identity-stability reasoning.
  const handleTrack: CasesIndexClickHandler = useCallback(
    (target) => {
      onTrack(target, card);
    },
    [onTrack, card]
  );
  const handleOpen = useCallback(() => {
    handleTrack('case');
  }, [handleTrack]);
  const handleJoin = useCallback(() => {
    handleTrack('join');
  }, [handleTrack]);

  return (
    <article
      className={cn(
        'border-border bg-card relative grid overflow-hidden rounded-2xl border shadow-md',
        'grid-cols-1 md:grid-cols-[minmax(0,1fr)_250px]'
      )}
    >
      <div className="flex min-w-0 flex-col p-6">
        <Link
          href={card.href}
          onClick={handleOpen}
          className="focus-visible:ring-ring block rounded-md focus-visible:ring-2 focus-visible:outline-none"
        >
          <span
            className={cn(
              'flex items-center gap-1.5 text-[12.5px] font-semibold',
              live ? 'text-emerald-700 dark:text-emerald-400' : 'text-primary'
            )}
          >
            <Video className="size-3.5" aria-hidden="true" />
            {CASES_INDEX_FEATURED_EYEBROW}
          </span>
          <span className="text-foreground mt-2 line-clamp-2 block text-xl font-semibold tracking-tight md:text-2xl">
            {card.title}
          </span>
          <CaseCounterpartyLine card={card} size="size-8" />
          {tags.shown.length > 0 && (
            <span className="mt-2.5 flex flex-wrap gap-1.5">
              {tags.shown.map((tag) => (
                <span
                  key={tag}
                  className="border-border bg-muted text-muted-foreground rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium"
                >
                  {tag}
                </span>
              ))}
              {tags.overflow > 0 && (
                <span className="border-border bg-muted text-muted-foreground/70 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium">
                  +{tags.overflow}
                </span>
              )}
            </span>
          )}
        </Link>

        <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
          <CaseTrail trail={card.trail} />
          <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-3 text-[12.5px]">
            {card.heldCount > 0 && <span>{casesIndexHeldCount(card.heldCount)}</span>}
            {card.actionItemsForYou > 0 && (
              <span className="inline-flex items-center gap-1">
                <ListChecks className="size-3.5" aria-hidden="true" />
                {casesIndexItemsForYou(card.actionItemsForYou)}
              </span>
            )}
            {card.unread && (
              <span className="text-primary inline-flex items-center gap-1 font-semibold">
                <MessageSquare className="size-3.5" aria-hidden="true" />
                {CASES_INDEX_UNREAD}
              </span>
            )}
          </span>
          <Link
            href={card.href}
            onClick={handleOpen}
            className="text-primary ml-auto inline-flex items-center gap-1 text-[12.5px] font-semibold"
          >
            {CASES_INDEX_OPEN_CASE}
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {/* The stub. The dashed rule IS the perforation — top on mobile, left from `md` up. */}
      <div
        className={cn(
          'flex flex-col items-start border-t-2 border-dashed p-6 md:border-t-0 md:border-l-2',
          live
            ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10'
            : 'border-primary/30 bg-primary/5'
        )}
      >
        {booking === null ? (
          <TicketStubSkeleton />
        ) : (
          <>
            <span className="text-muted-foreground text-[13px] font-semibold">
              {booking.dowLong}
            </span>
            <span className="text-foreground my-0.5 text-5xl leading-none font-bold tracking-tighter tabular-nums">
              {booking.day}
            </span>
            <span className="text-muted-foreground text-[13px]">{booking.monLong}</span>
            <span
              aria-hidden="true"
              className={cn(
                'my-3.5 h-px self-stretch',
                live ? 'bg-emerald-300 dark:bg-emerald-500/40' : 'bg-primary/30'
              )}
            />
            <span className="text-foreground text-lg font-semibold tracking-tight">
              {booking.time}
            </span>
            <span className="text-muted-foreground mb-2.5 text-[12.5px]">
              {booking.durationMinutes} minutes
            </span>
          </>
        )}

        {timing !== null && timing.statusText !== null && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
            <span className="size-[7px] rounded-full bg-emerald-500" aria-hidden="true" />
            {timing.statusText}
          </span>
        )}
        {timing !== null && !timing.joinVisible && booking !== null && (
          <span className="text-primary ring-primary/30 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset">
            <Clock className="size-3" aria-hidden="true" />
            {booking.relative}
          </span>
        )}

        <JoinSlot
          joinPath={live ? card.joinPath : null}
          hasReadableBooking={booking !== null}
          ariaLabel={joinAffordanceAriaLabel(card.counterpartyName, timing?.timingLabel ?? null)}
          onJoin={handleJoin}
        />
      </div>
    </article>
  );
}

/**
 * The stub's action row: Join, the "when it opens" hint, or NOTHING.
 *
 * ⚠⚠ THE HINT REQUIRES A READABLE BOOKING (fix round X5). It used to be the unconditional `else`,
 * so the card promised "Join opens 15 min before" even when it could not read the time it was
 * counting back FROM — during the pre-clock first paint, and in the (rare) case where the
 * repository says a case is booked but its trail carries no matching meeting. Telling somebody
 * when they can join a call whose time you do not have is a CONFIDENT WRONG ANSWER, which is
 * worse on this surface than saying nothing: the stub is already showing a skeleton there, which
 * reads honestly as "still loading".
 */
function JoinSlot({
  joinPath,
  hasReadableBooking,
  ariaLabel,
  onJoin,
}: Readonly<{
  /** Non-null ONLY when the viewer's clock puts this card inside the join window. */
  joinPath: string | null;
  hasReadableBooking: boolean;
  ariaLabel: string;
  onJoin: () => void;
}>): React.JSX.Element | null {
  if (joinPath !== null) {
    return (
      <div className="mt-3.5 w-full">
        <JoinMeetingButton
          joinUrl={joinPath}
          className="min-h-11 w-full"
          ariaLabel={ariaLabel}
          onJoin={onJoin}
        >
          <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
          {CASES_INDEX_JOIN}
        </JoinMeetingButton>
      </div>
    );
  }
  if (!hasReadableBooking) return null;
  return (
    <div className="mt-3.5 w-full">
      <span className="text-muted-foreground/80 block text-xs">{CASES_INDEX_JOIN_HINT}</span>
    </div>
  );
}

/** The stub before the viewer's clock lands — never a server-zone time that would then jump. */
function TicketStubSkeleton(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="block w-full">
      <span className="bg-muted block h-4 w-20 animate-pulse rounded" />
      <span className="bg-muted mt-2 block h-10 w-16 animate-pulse rounded" />
      <span className="bg-muted mt-2 block h-4 w-24 animate-pulse rounded" />
    </span>
  );
}
