'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { RoomSettingUpSlot } from '@/components/balo/meetings/room-setting-up-slot';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { joinAffordanceAriaLabel } from '@/lib/calendar/join-window';
import { meetingTypeLabel } from '@/lib/meetings/meeting-type-label';
import { UP_NEXT_JOIN } from '@/lib/meetings/up-next-copy';
import { NAV_CALL_LIST_TITLE, navMoreCallsAriaLabel } from './nav-call-copy';
import { navCallPartyName, type NavCallCandidate } from './nav-call-model';

interface MoreCallsListProps {
  /** Never empty — the caller renders nothing for zero. */
  readonly others: readonly NavCallCandidate[];
  /** Fired on OPEN only. */
  readonly onOpen: () => void;
  readonly onJoin: (candidate: NavCallCandidate) => void;
}

interface MoreCallRowProps {
  readonly candidate: NavCallCandidate;
  readonly onJoin: (candidate: NavCallCandidate) => void;
}

/** "{type label}, {status line lowercased}" — the room-setting-up row has no status line. */
function rowSubtitle(candidate: NavCallCandidate): string {
  const typeLabel = meetingTypeLabel(candidate.call.contextType);
  const { statusLine } = candidate.timing;
  return statusLine === null ? typeLabel : `${typeLabel}, ${statusLine.toLowerCase()}`;
}

function MoreCallRow({ candidate, onJoin }: Readonly<MoreCallRowProps>): React.JSX.Element {
  const { call, timing } = candidate;
  const name = navCallPartyName(call);
  const handleJoin = useCallback(() => onJoin(candidate), [candidate, onJoin]);

  const text = (
    <>
      <span className="text-foreground block truncate text-[13px] font-semibold">{name}</span>
      <span className="text-muted-foreground block truncate text-xs">{rowSubtitle(candidate)}</span>
    </>
  );

  return (
    <li className="flex items-center gap-3 rounded-lg px-2.5 py-2">
      {call.href === null ? (
        <span className="min-w-0 flex-1">{text}</span>
      ) : (
        <Link
          href={call.href}
          className="focus-visible:ring-ring min-w-0 flex-1 rounded focus-visible:ring-2 focus-visible:outline-none"
        >
          {text}
        </Link>
      )}
      {timing.joinVisible ? (
        <JoinMeetingButton
          joinUrl={call.joinPath}
          size="sm"
          liveCue={false}
          registerOnPage={false}
          className="h-9 px-3 text-[13px] after:-inset-1.5"
          ariaLabel={joinAffordanceAriaLabel(name, timing.joinTimingLabel)}
          onJoin={handleJoin}
        >
          <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
          {UP_NEXT_JOIN}
        </JoinMeetingButton>
      ) : (
        <RoomSettingUpSlot variant="button" label="short" className="h-8" />
      )}
    </li>
  );
}

/**
 * BAL-636 — the "+N" trigger and its list of the other calls that can be joined. Every Join in
 * the list is static (`liveCue={false}`): the pill's primary Join is the one moving thing. Escape
 * and outside-click come from the Popover.
 */
export function MoreCallsList({
  others,
  onOpen,
  onJoin,
}: Readonly<MoreCallsListProps>): React.JSX.Element {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) onOpen();
    },
    [onOpen]
  );

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={navMoreCallsAriaLabel(others.length)}
          className="border-border bg-background hover:bg-muted focus-visible:ring-ring relative inline-flex h-9 min-w-9 items-center justify-center rounded-md border px-2 text-xs font-semibold after:absolute after:-inset-1.5 after:content-[''] focus-visible:ring-2 focus-visible:outline-none sm:h-8 sm:min-w-8 sm:border-0 sm:bg-transparent sm:px-1.5"
        >
          +{others.length}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={NAV_CALL_LIST_TITLE}
        className="w-[300px] max-w-[calc(100vw-1.5rem)] p-1.5"
      >
        <p className="text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-semibold">
          {NAV_CALL_LIST_TITLE}
        </p>
        <ul>
          {others.map((candidate) => (
            <MoreCallRow key={candidate.call.meetingId} candidate={candidate} onJoin={onJoin} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
