'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { useLiveJoinOnPage } from '@/components/balo/meetings/live-join-registry';
import { RoomSettingUpSlot } from '@/components/balo/meetings/room-setting-up-slot';
import { useSidebar } from '@/components/layout/sidebar-context';
import { useServerAnchoredClock } from '@/hooks/use-server-anchored-clock';
import { NAV_EVENTS, track } from '@/lib/analytics';
import { JOIN_CLOCK_TICK_MS, joinAffordanceAriaLabel } from '@/lib/calendar/join-window';
import { meetingTypeLabel } from '@/lib/meetings/meeting-type-label';
import type { NavCallsResponse } from '@/lib/meetings/nav-call-view-types';
import { UP_NEXT_JOIN } from '@/lib/meetings/up-next-copy';
import { useRoomReadyRefetch } from '@/lib/meetings/use-room-ready-refetch';
import { MoreCallsList } from './more-calls-list';
import { navCallReadyAnnouncement } from './nav-call-copy';
import {
  navCallEventProps,
  navCallIsQuiet,
  navCallPartyName,
  selectNavCalls,
  type NavCallCandidate,
} from './nav-call-model';
import { useNavCalls } from './use-nav-calls';

interface NavCallPillViewProps {
  readonly data: NavCallsResponse;
  readonly refetch: () => void;
  readonly onAnnounce: (meetingId: string, text: string) => void;
  readonly onAnnounceClear: () => void;
}

function NavCallPillView({
  data,
  refetch,
  onAnnounce,
  onAnnounceClear,
}: Readonly<NavCallPillViewProps>): React.JSX.Element | null {
  const pathname = usePathname();
  const { navContext } = useSidebar();
  const workspaceType = navContext.workspaceType;
  const { now } = useServerAnchoredClock(data.serverNowIso, JOIN_CLOCK_TICK_MS);

  const { primary, others } = useMemo(
    () => selectNavCalls(data.calls, now, pathname),
    [data.calls, now, pathname]
  );
  const joinOnPage = useLiveJoinOnPage(primary?.call.joinPath ?? null);
  const quiet =
    primary === null
      ? true
      : navCallIsQuiet({ joinOnPage, now, scheduledEnd: new Date(primary.call.scheduledEnd) });

  // Keyed on the latest-start candidate deliberately: its refetch deadline covers every earlier call.
  const settingUp = [primary, ...others].find((candidate) => candidate?.timing.roomSettingUp);
  useRoomReadyRefetch(settingUp !== undefined, settingUp?.call.scheduledStart ?? '', refetch);

  const shownIds = useRef<Set<string>>(new Set());

  const primaryId = primary?.call.meetingId ?? null;
  const primaryName = primary === null ? '' : navCallPartyName(primary.call);
  const announceable = primary !== null && primary.timing.joinVisible && !quiet;
  useEffect(() => {
    if (primaryId !== null && announceable) {
      onAnnounce(primaryId, navCallReadyAnnouncement(primaryName));
    } else {
      onAnnounceClear();
    }
  }, [primaryId, announceable, primaryName, onAnnounce, onAnnounceClear]);

  useEffect(() => {
    if (primary === null || shownIds.current.has(primary.call.meetingId)) return;
    shownIds.current.add(primary.call.meetingId);
    track(NAV_EVENTS.CALL_PILL_SHOWN, navCallEventProps(primary, { now, quiet, workspaceType }));
  }, [primary, now, quiet, workspaceType]);

  const handlePillJoin = useCallback(() => {
    if (primary === null) return;
    track(NAV_EVENTS.CALL_JOIN_CLICKED, {
      ...navCallEventProps(primary, { now, quiet, workspaceType }),
      source: 'pill',
    });
  }, [primary, now, quiet, workspaceType]);

  const handleListOpen = useCallback(() => {
    if (primary === null) return;
    track(NAV_EVENTS.CALL_LIST_OPENED, {
      ...navCallEventProps(primary, { now, quiet, workspaceType }),
      count: others.length,
    });
  }, [primary, others.length, now, quiet, workspaceType]);

  const handleListJoin = useCallback(
    (candidate: NavCallCandidate) => {
      track(NAV_EVENTS.CALL_JOIN_CLICKED, {
        ...navCallEventProps(candidate, { now, quiet: true, workspaceType }),
        source: 'list',
      });
    },
    [now, workspaceType]
  );

  if (primary === null) return null;

  const { call, timing } = primary;
  const name = navCallPartyName(call);
  const statusLine = timing.statusLine ?? meetingTypeLabel(call.contextType);
  const textBlock = (
    <>
      <span className="text-foreground block truncate text-[13px] font-semibold">{name}</span>
      <span className="text-muted-foreground block truncate text-xs font-medium">{statusLine}</span>
    </>
  );

  return (
    <div
      data-testid="nav-call-pill"
      className="motion-safe:animate-fade-in sm:border-border sm:bg-background flex items-center gap-3 sm:h-10 sm:max-w-[340px] sm:rounded-lg sm:border sm:pr-1 sm:pl-3"
    >
      <div className="hidden min-w-0 sm:block">
        {call.href === null ? (
          <span className="block min-w-0">{textBlock}</span>
        ) : (
          <Link
            href={call.href}
            className="focus-visible:ring-ring block min-w-0 rounded focus-visible:ring-2 focus-visible:outline-none"
          >
            {textBlock}
          </Link>
        )}
      </div>
      {timing.joinVisible ? (
        <JoinMeetingButton
          joinUrl={call.joinPath}
          size="sm"
          liveCue={!quiet}
          registerOnPage={false}
          className="h-9 px-3 text-[13px] after:-inset-1.5 sm:h-8"
          ariaLabel={joinAffordanceAriaLabel(name, timing.joinTimingLabel)}
          onJoin={handlePillJoin}
        >
          <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
          {UP_NEXT_JOIN}
        </JoinMeetingButton>
      ) : (
        <>
          <RoomSettingUpSlot variant="button" label="short" className="hidden h-8 sm:inline-flex" />
          <RoomSettingUpSlot variant="chip" className="rounded-md sm:hidden" />
        </>
      )}
      {others.length > 0 && (
        <MoreCallsList others={others} onOpen={handleListOpen} onJoin={handleListJoin} />
      )}
    </div>
  );
}

/**
 * BAL-636 — the top-nav call pill: one affordance, on every dashboard-shell page, that joins a
 * call whose window is open. Shows nothing visible while loading, after an error, and for an
 * impersonated session (the bell's passive posture). The view mounts only after the first response
 * so the server-anchored clock anchors to a real server instant. The `role="status"` region lives
 * out here so it is in the DOM from the first render — a live region inserted together with its
 * text is not reliably announced — and each meeting is announced at most once per mount.
 */
export function NavCallPill(): React.JSX.Element {
  const { data, refetch } = useNavCalls();
  const announcedIds = useRef<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');

  // The meeting whose text the region holds now. A repeat call for it is a no-op, so StrictMode's
  // effect re-run keeps the text; a return to an earlier meeting clears it instead of re-announcing.
  const currentAnnouncedId = useRef<string | null>(null);
  const handleAnnounce = useCallback((meetingId: string, text: string) => {
    if (currentAnnouncedId.current === meetingId) return;
    if (announcedIds.current.has(meetingId)) {
      currentAnnouncedId.current = null;
      setAnnouncement('');
      return;
    }
    announcedIds.current.add(meetingId);
    currentAnnouncedId.current = meetingId;
    setAnnouncement(text);
  }, []);
  const handleAnnounceClear = useCallback(() => {
    currentAnnouncedId.current = null;
    setAnnouncement('');
  }, []);
  const viewMounted = data !== null && !data.impersonating;

  return (
    <>
      <span role="status" className="sr-only">
        {viewMounted ? announcement : ''}
      </span>
      {viewMounted && (
        <NavCallPillView
          data={data}
          refetch={refetch}
          onAnnounce={handleAnnounce}
          onAnnounceClear={handleAnnounceClear}
        />
      )}
    </>
  );
}
