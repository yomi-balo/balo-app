'use client';

import { memo, useCallback } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { Video, Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { ENGAGEMENT_TYPE_INDICATOR } from '@/lib/calendar/engagement-type-indicator';
import { formatZonedTimeRange, formatZonedTime } from '@/lib/calendar/zoned-grid';
import { joinAffordanceAriaLabel } from '@/lib/calendar/join-window';
import type { CalendarMeetingView } from '../_lib/calendar-view-types';
import { JoinMeetingButton } from './join-meeting-button';

interface MeetingBlockProps {
  readonly meeting: CalendarMeetingView;
  readonly timezone: string;
  readonly top: number;
  readonly height: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
  /** The meeting is over AND its join grace has elapsed (or its status is terminal), as of the
   *  shell's last 60-second tick. Never true while `joinVisible` is. */
  readonly isPast: boolean;
  /** Join is inside its window, as of the shell's last 60-second tick. */
  readonly joinVisible: boolean;
  /** The Join `aria-label`'s timing suffix ("starting now" / "starting in 5 minutes").
   *  `null` exactly when `joinVisible` is false — see `calendarMeetingTiming`. */
  readonly joinTimingLabel: string | null;
  readonly onJoinClick: (meeting: CalendarMeetingView) => void;
  /** The 0:00-anchored second half of a meeting that crosses local midnight — same meeting,
   *  same targets, rendered in the NEXT day's column so it never silently disappears. */
  readonly isContinuationFragment?: boolean;
}

/** Below this rendered height, a full block (time + title + badge) does not fit. */
const COMPACT_HEIGHT_PX = 24;

/**
 * BAL-498 — one absolutely-positioned meeting card within a Week day column. The card body is an
 * in-app `next/link` to the owning engagement detail (ordinary client-side navigation — the
 * plain-anchor rule never covered these routes; fix round 3, R5). Join is a SEPARATE click target
 * and is a `<button>`, NOT a link: see {@link JoinMeetingButton} for why the lobby URL must never
 * become a DOM attribute, and why the navigation it performs is still a hard document
 * navigation (D4 / the `/join/` invariant).
 *
 * COMPACT MODE (< 24px, e.g. a 15-minute case): the inline Join button is suppressed — an
 * absolutely-positioned icon button over a 16px card occludes the only line of text and is
 * unreachable at any input method once it does. Instead a small info affordance opens a `Popover`
 * (tap AND click) with the full time range, party name, and a real Join link, so nothing about a
 * short meeting is actually unreachable (design "Week" section, compact-block rule).
 *
 * ⚠ MEMOISED — DO NOT REINTRODUCE A `now`/OBJECT PROP (BAL-511 D1). `CalendarShell` ticks `now`
 * every 60 seconds and re-renders the whole tree; without this memo every `MeetingBlock` on the
 * page — a full week's worth — re-rendered on every tick regardless of whether anything about it
 * actually changed. `WeekGrid` now computes `isPast`/`joinVisible`/`joinTimingLabel` via
 * `calendarMeetingTiming` and hands down three PRIMITIVES, never the composed object and never
 * `now` itself — every prop here must stay a primitive or a reference the parent memoises, or the
 * comparison this wrapper performs degrades back to a no-op.
 */
export const MeetingBlock = memo(function MeetingBlock({
  meeting,
  timezone,
  top,
  height,
  leftPercent,
  widthPercent,
  isPast,
  joinVisible,
  joinTimingLabel,
  onJoinClick,
  isContinuationFragment = false,
}: Readonly<MeetingBlockProps>): React.JSX.Element {
  const indicator = ENGAGEMENT_TYPE_INDICATOR[meeting.contextType];
  const Icon = indicator.icon;
  const compact = height < COMPACT_HEIGHT_PX;
  const partyName = meeting.counterpartyCompanyName ?? 'Balo';
  const timeRange = formatZonedTimeRange(meeting.scheduledStart, meeting.scheduledEnd, timezone);
  const accessibleLabel = `${timeRange}, ${indicator.label} with ${partyName}${
    isContinuationFragment ? ', continued from yesterday' : ''
  }`;
  const joinAriaLabel = joinAffordanceAriaLabel(partyName, joinTimingLabel);
  const continuationPrefix = isContinuationFragment ? '⌃ ' : '';
  const compactLabel = `${formatZonedTime(meeting.scheduledStart, timezone)} ${partyName}`;
  const fullLabel = `${continuationPrefix}${timeRange}`;
  const handleJoin = useCallback(() => onJoinClick(meeting), [onJoinClick, meeting]);

  const cardBody = (
    <span
      className={cn(
        'bg-card border-border block h-full w-full overflow-hidden rounded-lg border-y border-r border-l-[3px] p-1.5 text-left shadow-sm',
        indicator.borderClass,
        isPast && 'opacity-60',
        isContinuationFragment && 'rounded-t-none'
      )}
    >
      <span
        className={cn(
          'text-foreground block truncate font-medium',
          compact ? 'text-[10px]' : 'text-xs'
        )}
      >
        {compact ? compactLabel : fullLabel}
      </span>
      {!compact && (
        <>
          <span className="text-foreground mt-0.5 block truncate text-sm font-semibold">
            {partyName}
          </span>
          <span className="text-muted-foreground mt-0.5 inline-flex items-center gap-1 text-[11px]">
            <Icon className="h-3 w-3" aria-hidden="true" />
            {indicator.label}
          </span>
        </>
      )}
    </span>
  );

  return (
    <motion.div
      className="absolute"
      style={{ top, height, left: `${leftPercent}%`, width: `${widthPercent}%` }}
      whileHover={{ y: -2, boxShadow: '0 4px 12px rgb(0 0 0 / 0.12)' }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.2 }}
    >
      {meeting.href === null ? (
        // H12 stands: an `aria-label` on a BARE `<span>` is dropped by every AT, so the
        // non-navigable card must sit on an element that actually carries a role. Round 6 item 3
        // only changes WHICH element supplies it: `<article>` — a self-contained composition, the
        // exact fit for a meeting card — instead of a `<span role="group">`. SonarCloud S6819
        // ("use the real element, not the ARIA role") is satisfied by dropping the explicit role;
        // the accessible NAME, which is the whole point of the H12 repair, is unchanged.
        <article aria-label={accessibleLabel} className="block h-full w-full">
          {cardBody}
        </article>
      ) : (
        <Link
          href={meeting.href}
          aria-label={accessibleLabel}
          className="focus-visible:ring-ring block h-full w-full rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        >
          {cardBody}
        </Link>
      )}
      {joinVisible && !compact && (
        <JoinMeetingButton
          joinUrl={meeting.joinUrl}
          ariaLabel={joinAriaLabel}
          onJoin={handleJoin}
          size="icon-xs"
          // A1 — the 24px visual chip keeps its docked corner position; `after:-inset-2.5`
          // (10px each side) grows the ACTUAL tap target to 44px, so a hurried thumb no longer
          // lands on the card's detail link seconds before a call. The live ping ring and its
          // reduced-motion fallback (BAL-511 / ADR-1053) are now baked into `JoinMeetingButton`
          // itself — see that component's docblock.
          className="absolute top-0.5 right-0.5 z-10 rounded-full after:-inset-2.5"
        >
          <Video className="h-3 w-3" aria-hidden="true" />
        </JoinMeetingButton>
      )}
      {compact && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              aria-label={`Details for ${partyName}'s ${indicator.label.toLowerCase()}, ${timeRange}`}
              // A4 — the 14px visual is kept; the hit area is extended by a transparent
              // pseudo-element rather than the usual `-m-3 p-3`, because this button is
              // ABSOLUTELY positioned and negative margins would drag the visual chip out of the
              // card corner. `-inset-3` (12px) buys 38px, matching the 24px of extra target that
              // `-m-3 p-3` would have given: a compact block is under 24px TALL, so a literal
              // 44px square here would blanket the card's own detail link and make the meeting
              // itself unreachable — the one outcome worse than a small target.
              className="bg-card border-border text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-0 right-0 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-bl border-b border-l after:absolute after:-inset-3 after:content-[''] focus-visible:ring-2 focus-visible:outline-none"
            >
              <Info className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 text-sm" onClick={(event) => event.stopPropagation()}>
            <p className="text-foreground font-semibold">{timeRange}</p>
            <p className="text-muted-foreground mt-0.5 inline-flex items-center gap-1 text-xs">
              <Icon className="h-3 w-3" aria-hidden="true" />
              {indicator.label} with {partyName}
            </p>
            {joinVisible && (
              <JoinMeetingButton
                joinUrl={meeting.joinUrl}
                ariaLabel={joinAriaLabel}
                onJoin={handleJoin}
                size="sm"
                // In normal flow inside the popover, so the 44px minimum is met directly. Also
                // the net-new site for the live ping ring (BAL-511 D2) — it now inherits the cue
                // and reduced-motion fallback from `JoinMeetingButton` like the other two sites.
                className="mt-2 min-h-11 w-full"
              >
                <Video className="h-4 w-4" aria-hidden="true" />
                Join
              </JoinMeetingButton>
            )}
          </PopoverContent>
        </Popover>
      )}
    </motion.div>
  );
});
