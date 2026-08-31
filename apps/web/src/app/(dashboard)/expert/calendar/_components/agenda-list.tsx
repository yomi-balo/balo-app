'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import { ChevronRight, Video } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  zonedDayKey,
  todayDayKey,
  addDaysToDayKey,
  formatZonedTimeRange,
} from '@/lib/calendar/zoned-grid';
import { ENGAGEMENT_TYPE_INDICATOR } from '@/lib/calendar/engagement-type-indicator';
import {
  calendarJoinAffordanceVisible,
  joinAffordanceTimingLabel,
} from '@/lib/calendar/join-window';
import type { CalendarMeetingView } from '../_lib/calendar-view-types';
import { JoinMeetingButton } from './join-meeting-button';

interface AgendaListProps {
  readonly meetings: readonly CalendarMeetingView[];
  readonly timezone: string;
  readonly now: Date;
  readonly onJoinClick: (meeting: CalendarMeetingView) => void;
}

function groupLabel(dayKey: string, today: string, tomorrow: string): string {
  if (dayKey === today) return 'Today';
  if (dayKey === tomorrow) return 'Tomorrow';
  const [year, month, day] = dayKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return dayKey;
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * BAL-498 — the chronological Agenda list. Sticky Today/Tomorrow/date group headers, a "Now"
 * divider inside Today's group (Agenda's equivalent of the Week now-line — the one orientation
 * cue on the mobile-default surface), past rows muted. Join REPLACES the chevron on an imminent
 * row (a row cannot show both without visual competition — Join wins, the row body itself remains
 * the "go to detail" target).
 */
export function AgendaList({
  meetings,
  timezone,
  now,
  onJoinClick,
}: Readonly<AgendaListProps>): React.JSX.Element {
  const today = todayDayKey(timezone, now);
  const tomorrow = addDaysToDayKey(today, 1);

  const groups = new Map<string, CalendarMeetingView[]>();
  for (const meeting of meetings) {
    const dayKey = zonedDayKey(meeting.scheduledStart, timezone);
    const bucket = groups.get(dayKey);
    if (bucket === undefined) {
      groups.set(dayKey, [meeting]);
    } else {
      bucket.push(meeting);
    }
  }
  // ⚠ EXPLICIT COMPARATOR (SonarCloud S2871). Zero-padded ISO day keys happen to sort
  // chronologically under the default (lexicographic-on-`String(x)`) sort, but a comparator-less
  // `.sort()` is a reliability bug by rule — the same `localeCompare` shape `dayMeetings` uses
  // two lines below (BAL-498 fix round 5, B1).
  const orderedDayKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-6">
      {orderedDayKeys.map((dayKey) => {
        const dayMeetings = [...(groups.get(dayKey) ?? [])].sort((a, b) =>
          a.scheduledStart.localeCompare(b.scheduledStart)
        );
        const isTodayGroup = dayKey === today;
        // The "Now" divider sits immediately BEFORE the first meeting whose end is still in the
        // future — i.e. between the last past row and the first upcoming one. When every row in
        // Today's group has already ended, `findIndex` returns `-1`; that must still place the
        // divider AFTER the last row (`dayMeetings.length`), not suppress it — at 18:00 after a
        // full day of calls this is the ONE orientation cue on the mobile-default surface (H8).
        // `-1` here (never equal to any valid index OR `dayMeetings.length`) suppresses the
        // divider for every non-Today group, where it has no meaning.
        const upcomingIndex = isTodayGroup
          ? dayMeetings.findIndex(
              (meeting) => now.getTime() < new Date(meeting.scheduledEnd).getTime()
            )
          : -1;
        const nowDividerIndex =
          isTodayGroup && upcomingIndex === -1 ? dayMeetings.length : upcomingIndex;
        return (
          <div key={dayKey}>
            <h3 className="text-muted-foreground bg-background sticky top-0 py-1.5 text-xs font-semibold tracking-wide uppercase">
              {groupLabel(dayKey, today, tomorrow)}
            </h3>
            <div className="divide-border divide-y">
              {dayMeetings.map((meeting, index) => {
                const isPast = now.getTime() >= new Date(meeting.scheduledEnd).getTime();
                const indicator = ENGAGEMENT_TYPE_INDICATOR[meeting.contextType];
                const Icon = indicator.icon;
                const start = new Date(meeting.scheduledStart);
                const joinVisible = calendarJoinAffordanceVisible(
                  now,
                  start,
                  new Date(meeting.scheduledEnd)
                );
                const joinAriaLabel = `Join ${meeting.counterpartyCompanyName ?? 'Balo'}'s meeting, ${joinAffordanceTimingLabel(now, start)}`;
                const partyName = meeting.counterpartyCompanyName ?? 'Balo';
                // ⚠ NEVER NEST INTERACTIVE ELEMENTS. The row-body link and the Join control are
                // SIBLING click targets, not parent/child — an `<a>`/`<button>` inside an `<a>`
                // is invalid HTML that browsers/jsdom silently reparent, breaking both the
                // semantics and the "row body still links to detail, Join is separate" contract.
                const rowBody = (
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="text-foreground w-28 shrink-0 text-sm font-semibold tabular-nums">
                      {formatZonedTimeRange(meeting.scheduledStart, meeting.scheduledEnd, timezone)}
                    </span>
                    <Icon className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                      {partyName}
                    </span>
                  </span>
                );
                return (
                  <div key={meeting.meetingId}>
                    {index === nowDividerIndex && <NowDivider />}
                    <motion.div
                      className={cn(
                        'flex min-h-14 items-center gap-3 px-2 py-3',
                        isPast && 'opacity-60'
                      )}
                      whileTap={{ scale: 0.99 }}
                      transition={{ duration: 0.15 }}
                    >
                      {meeting.href === null ? (
                        rowBody
                      ) : (
                        <Link
                          href={meeting.href}
                          className="focus-visible:ring-ring flex min-w-0 flex-1 rounded-lg focus-visible:ring-2 focus-visible:outline-none"
                        >
                          {rowBody}
                        </Link>
                      )}
                      {joinVisible ? (
                        <JoinMeetingButton
                          joinUrl={meeting.joinUrl}
                          ariaLabel={joinAriaLabel}
                          onJoin={() => onJoinClick(meeting)}
                          size="sm"
                          // A1 — Agenda is the MOBILE DEFAULT surface and this is the page's one
                          // moment of urgency: `min-h-11` + `px-4` puts the real tap target at
                          // 44px, up from `size="sm"`'s 32px.
                          className="motion-reduce:ring-primary/40 min-h-11 px-4 motion-safe:animate-pulse motion-reduce:ring-2"
                        >
                          <Video className="h-4 w-4" aria-hidden="true" />
                          Join
                        </JoinMeetingButton>
                      ) : (
                        <ChevronRight
                          className="text-muted-foreground h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                    </motion.div>
                  </div>
                );
              })}
              {nowDividerIndex === dayMeetings.length && <NowDivider />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The current-time marker inside Today's group — Agenda's equivalent of the Week now-line,
 *  driven by the same 60-second tick as every other "now"-dependent element on the page. */
function NowDivider(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-1" aria-hidden="true">
      <span className="border-destructive/60 flex-1 border-t border-dashed" />
      <span className="text-destructive text-[10px] font-semibold tracking-wide uppercase">
        Now
      </span>
      <span className="border-destructive/60 flex-1 border-t border-dashed" />
    </div>
  );
}
