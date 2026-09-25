'use client';

import { useCallback, useId } from 'react';
import Link from 'next/link';
import { Briefcase, Compass, Handshake, Video, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, DASHBOARD_EVENTS } from '@/lib/analytics';
import { joinAffordanceAriaLabel } from '@/lib/calendar/join-window';
import { meetingTypeLabel } from '@/lib/meetings/meeting-type-label';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { RoomSettingUpSlot } from '@/components/balo/meetings/room-setting-up-slot';
import {
  formatUpNextWhen,
  resolveRescheduleNote,
  resolveUpNextRowTiming,
} from '../_lib/up-next-presentation';
import { UP_NEXT_JOIN } from '../_lib/up-next-copy';
import type { ViewerClock } from '@/hooks/use-viewer-clock';
import type { UpNextRowView, UpNextWorkspaceType } from '../_lib/up-next-view-types';

interface UpNextRowProps {
  readonly row: UpNextRowView;
  readonly clock: ViewerClock | null;
  readonly workspaceType: UpNextWorkspaceType;
  readonly featured: boolean;
}

interface TypePresentation {
  readonly icon: LucideIcon;
  /** Background + foreground, for the tile. */
  readonly tileClassName: string;
  /** Foreground only, for the type-label text. */
  readonly labelClassName: string;
}

/** Case is indigo (`primary`); the three project-side types share the `violet` token. */
const UP_NEXT_TYPE_PRESENTATION: Record<UpNextRowView['contextType'], TypePresentation> = {
  case: {
    icon: Video,
    tileClassName: 'bg-primary/10 text-primary',
    labelClassName: 'text-primary',
  },
  project_kickoff: {
    icon: Briefcase,
    tileClassName: 'bg-violet/10 text-violet',
    labelClassName: 'text-violet',
  },
  project_discovery: {
    icon: Compass,
    tileClassName: 'bg-violet/10 text-violet',
    labelClassName: 'text-violet',
  },
  request_interaction: {
    icon: Handshake,
    tileClassName: 'bg-violet/10 text-violet',
    labelClassName: 'text-violet',
  },
};

export function UpNextRow({
  row,
  clock,
  workspaceType,
  featured,
}: Readonly<UpNextRowProps>): React.JSX.Element {
  const presentation = UP_NEXT_TYPE_PRESENTATION[row.contextType];
  const Icon = presentation.icon;
  const label = meetingTypeLabel(row.contextType);
  // F14 — `useId()`, not the meeting id: a DOM `id`/`aria-describedby` built from `row.meetingId`
  // is exactly the shape PostHog autocapture ($elements[].id) and Sentry Session Replay (rrweb DOM
  // snapshots) pick up, and neither redaction hook walks a plain element id.
  const whenId = useId();

  const timing = clock === null ? null : resolveUpNextRowTiming(row, clock.now);
  const rescheduleNote =
    clock === null ? null : resolveRescheduleNote(row, clock.now, workspaceType);
  const when = clock === null ? null : formatUpNextWhen(row, clock.now, clock.timeZone);

  const handleRowClick = useCallback(() => {
    // Computed fresh at click time — accurate regardless of whether the 60s tick has landed yet.
    const rowState = resolveUpNextRowTiming(row, new Date()).rowState;
    track(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'row',
      meeting_type: row.contextType,
      row_state: rowState,
    });
  }, [row]);

  const handleJoinClick = useCallback(() => {
    const rowState = resolveUpNextRowTiming(row, new Date()).rowState;
    track(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'join',
      meeting_type: row.contextType,
      row_state: rowState,
    });
  }, [row]);

  const textBlock = (
    <>
      <span className={cn('block text-xs font-semibold', presentation.labelClassName)}>
        {label}
      </span>
      {row.title !== null && (
        <span className="text-foreground block truncate text-sm font-semibold">{row.title}</span>
      )}
      {row.counterpartyName !== null && (
        <span className="text-muted-foreground block truncate text-[12.5px]">
          {row.counterpartyName}
          {row.counterpartyOrgLabel !== null && (
            <span className="hidden sm:inline">, {row.counterpartyOrgLabel}</span>
          )}
        </span>
      )}
    </>
  );

  return (
    <div
      className={cn(
        'flex items-center gap-3',
        featured
          ? 'bg-success/10 ring-success/30 -mx-1 mb-1.5 rounded-xl px-3 py-3 ring-1 ring-inset'
          : 'border-border hover:bg-muted/50 border-b px-1 py-3 transition-colors last:border-b-0'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center rounded-[10px]',
          presentation.tileClassName
        )}
      >
        <Icon className="size-[17px]" />
      </span>
      {row.href === null ? (
        <div className="min-w-0 flex-1">{textBlock}</div>
      ) : (
        <Link
          href={row.href}
          aria-describedby={whenId}
          className="focus-visible:ring-ring min-w-0 flex-1 rounded-md focus-visible:ring-2 focus-visible:outline-none"
          onClick={handleRowClick}
        >
          {textBlock}
        </Link>
      )}
      <div id={whenId} className="shrink-0 text-right">
        {when === null || timing === null ? (
          <>
            <span aria-hidden="true" className="bg-muted block h-3.5 w-20 animate-pulse rounded" />
            <span
              aria-hidden="true"
              className="bg-muted mt-1 block h-3 w-12 animate-pulse rounded"
            />
          </>
        ) : (
          <>
            <span className="text-foreground block text-[13px] font-semibold">{when.primary}</span>
            <span className="text-muted-foreground block text-xs">{when.secondary}</span>
            {/* ⚠ RAW PALETTE, NOT `text-success` / `text-warning`, AND DELIBERATELY SO (raised and
                rejected twice in review). At 12px these are normal-size text, so they owe AA 4.5:1
                on the light card: `--success` (oklch L .623) lands ≈3.6:1 and `--warning`
                (L .77) ≈2.1:1, while emerald-700/amber-700 clear it — the tokens stay correct for
                icons, fills and the permanently-dark call surface. Same pairing as
                `credit/in-session-panel.tsx`. The featured row's `bg-success/10 ring-success/30`
                below IS a token: a fill carries no contrast obligation. */}
            {timing.statusLine !== null && (
              <span className="block text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                {timing.statusLine}
              </span>
            )}
            {rescheduleNote !== null && (
              <span className="block text-xs font-semibold text-amber-700 dark:text-amber-400">
                {rescheduleNote}
              </span>
            )}
          </>
        )}
      </div>
      {clock !== null && timing !== null && timing.joinVisible && (
        <JoinMeetingButton
          joinUrl={row.joinPath}
          size="sm"
          className="min-h-11 px-4"
          ariaLabel={joinAffordanceAriaLabel(row.counterpartyName ?? label, timing.joinTimingLabel)}
          onJoin={handleJoinClick}
        >
          <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
          {UP_NEXT_JOIN}
        </JoinMeetingButton>
      )}
      {clock !== null && timing !== null && timing.roomSettingUp && (
        <RoomSettingUpSlot variant="button" label="short" className="min-h-11 px-4" />
      )}
    </div>
  );
}
