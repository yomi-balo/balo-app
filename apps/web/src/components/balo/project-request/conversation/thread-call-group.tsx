'use client';

import Link from 'next/link';
import { Calendar, CalendarPlus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useViewerClock, type ViewerClock } from '@/hooks/use-viewer-clock';
import type { UpcomingCallView } from '@/lib/project-request/conversation-view-types';
import { insideCaseJoinWindow } from '@/lib/cases/case-join-window';
import {
  joinAffordanceAriaLabel,
  joinAffordanceTimingLabel,
  joinCountdownLabel,
} from '@/lib/calendar/join-window';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { deliveryWorkspaceHref } from '@/lib/engagement/delivery-workspace-href';
import { formatNextCallWhen } from '@/app/(dashboard)/dashboard/_lib/up-next-presentation';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { JoinCountdown } from '@/components/balo/meetings/join-countdown';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { CallSlot } from './thread-actions';

const BOOK_ANOTHER_LABEL = 'Book another call';

interface CallGroupProps {
  slot: CallSlot;
  /** Mobile rail sizing (44px targets, the group grows to fill the row). */
  mobile: boolean;
  callPending: boolean;
  /** `/experts/{u}?book=1&src=request_thread`; non-null only where the client books via the profile. */
  profileBookingHref: string | null;
  expertFirstName: string;
  /** Names the other party in the Join button's accessible name. */
  joinPartyLabel: string;
  onCall: () => void;
  onBookAnother: () => void;
  onJoin: (call: UpcomingCallView) => void;
}

interface NextCallLineProps {
  slot: CallSlot;
  upcomingCalls: readonly UpcomingCallView[];
  /** Non-null once kickoff materialized the engagement; the target of a `project_call` link. */
  deliveryEngagementId: string | null;
}

const OUTLINE_BUTTON =
  'border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center justify-center gap-1.5 rounded-[9px] border text-[12.5px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60';

function sizeClass(mobile: boolean): string {
  return mobile ? 'min-h-11 flex-1 px-3.5' : 'min-h-9 px-3';
}

/** "Propose times" (expert) and "Book a call" (client, in place) share one button. */
function CallButton({
  label,
  mobile,
  callPending,
  onCall,
}: Readonly<{
  label: string;
  mobile: boolean;
  callPending: boolean;
  onCall: () => void;
}>): React.JSX.Element {
  const iconSize = mobile ? 'h-4 w-4' : 'h-3.5 w-3.5';
  return (
    <button
      type="button"
      onClick={onCall}
      disabled={callPending}
      className={cn(OUTLINE_BUTTON, sizeClass(mobile), mobile && 'rounded-[11px] text-[13px]')}
    >
      {callPending ? (
        <Loader2 className={cn(iconSize, 'animate-spin')} aria-hidden="true" />
      ) : (
        <Calendar className={iconSize} aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

function BookViaProfileLink({
  mobile,
  href,
  expertFirstName,
  onCall,
}: Readonly<{
  mobile: boolean;
  href: string;
  expertFirstName: string;
  onCall: () => void;
}>): React.JSX.Element {
  return (
    <Link
      href={href}
      onClick={onCall}
      title={`Opens ${expertFirstName}'s profile to book a consultation`}
      className={cn(OUTLINE_BUTTON, sizeClass(mobile), mobile && 'rounded-[11px] text-[13px]')}
    >
      <Calendar className={mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
      Book a call
    </Link>
  );
}

/**
 * The ONE Join slot. Live (a real button) only inside the join window; before it, a
 * `JoinCountdown` that says when it opens. While the viewer clock is unresolved (server render
 * and first client render) the countdown shows the bare label, so the markup matches on both.
 */
function JoinSlot({
  next,
  clock,
  mobile,
  joinPartyLabel,
  onJoin,
}: Readonly<{
  next: UpcomingCallView;
  clock: ViewerClock | null;
  mobile: boolean;
  joinPartyLabel: string;
  onJoin: (call: UpcomingCallView) => void;
}>): React.JSX.Element {
  const className = mobile ? 'min-h-11 flex-1 px-4' : 'min-h-9 px-3';
  if (clock !== null && insideCaseJoinWindow(clock.now, next.scheduledStartIso)) {
    return (
      <JoinMeetingButton
        joinUrl={memberCallPath(next.meetingId)}
        size="sm"
        className={className}
        ariaLabel={joinAffordanceAriaLabel(
          joinPartyLabel,
          joinAffordanceTimingLabel(clock.now, new Date(next.scheduledStartIso))
        )}
        onJoin={() => onJoin(next)}
      >
        <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
        <span>Join now</span>
      </JoinMeetingButton>
    );
  }
  const label =
    clock === null ? 'Join' : joinCountdownLabel(clock.now, new Date(next.scheduledStartIso));
  return <JoinCountdown label={label} className={className} />;
}

function BookAnotherButton({
  mobile,
  onBookAnother,
}: Readonly<{ mobile: boolean; onBookAnother: () => void }>): React.JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={BOOK_ANOTHER_LABEL}
            onClick={onBookAnother}
            className={cn(
              OUTLINE_BUTTON,
              'shrink-0 px-0',
              mobile ? 'h-11 w-11 rounded-[11px]' : 'h-9 w-9'
            )}
          >
            <CalendarPlus className={mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{BOOK_ANOTHER_LABEL}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The call controls shared by the desktop header and the mobile rail, so there is one rendering
 * of every call state. Reads {@link useViewerClock}, which is `null` on the server and on the
 * first client render: nothing time-dependent is in the markup until the clock resolves.
 */
export function CallGroup({
  slot,
  mobile,
  callPending,
  profileBookingHref,
  expertFirstName,
  joinPartyLabel,
  onCall,
  onBookAnother,
  onJoin,
}: Readonly<CallGroupProps>): React.JSX.Element | null {
  const clock = useViewerClock();
  switch (slot.kind) {
    case 'none':
      return null;
    case 'propose':
      return (
        <CallButton
          label="Propose times"
          mobile={mobile}
          callPending={callPending}
          onCall={onCall}
        />
      );
    case 'shared':
      return (
        <span
          aria-disabled="true"
          className={cn(
            'border-border bg-muted/50 text-muted-foreground animate-in fade-in zoom-in-95 inline-flex items-center justify-center gap-1.5 rounded-full border px-3.5 text-xs font-medium motion-reduce:animate-none',
            mobile ? 'min-h-11 shrink-0' : 'min-h-9'
          )}
        >
          <Calendar className={mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
          Availability shared
        </span>
      );
    case 'book':
      if (slot.route === 'profile') {
        return profileBookingHref === null ? null : (
          <BookViaProfileLink
            mobile={mobile}
            href={profileBookingHref}
            expertFirstName={expertFirstName}
            onCall={onCall}
          />
        );
      }
      return (
        <CallButton label="Book a call" mobile={mobile} callPending={callPending} onCall={onCall} />
      );
    case 'upcoming':
      return (
        <div className={cn('flex gap-2', mobile && 'flex-1')}>
          <JoinSlot
            next={slot.next}
            clock={clock}
            mobile={mobile}
            joinPartyLabel={joinPartyLabel}
            onJoin={onJoin}
          />
          {slot.canBookAnother && (
            <BookAnotherButton mobile={mobile} onBookAnother={onBookAnother} />
          )}
        </div>
      );
  }
}

function WhenLabel({
  call,
  clock,
  deliveryEngagementId,
  className,
}: Readonly<{
  call: UpcomingCallView;
  clock: ViewerClock | null;
  deliveryEngagementId: string | null;
  className?: string;
}>): React.JSX.Element {
  if (clock === null) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'bg-muted inline-block h-3 w-24 animate-pulse rounded align-middle',
          className
        )}
      />
    );
  }
  const when = formatNextCallWhen(call.scheduledStartIso, clock.now, clock.timeZone);
  if (call.contextType === 'project_call' && deliveryEngagementId !== null) {
    return (
      <Link
        href={deliveryWorkspaceHref(deliveryEngagementId)}
        className={cn(
          'text-foreground focus-visible:ring-ring rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none',
          className
        )}
      >
        {when}
      </Link>
    );
  }
  return <span className={className}>{when}</span>;
}

/**
 * "Next call {when}" under the expert's name, with a "+N more" popover listing every upcoming
 * call. A `project_call` links to the delivery workspace; a `request_interaction` call is plain
 * text, because its target is the page already open.
 */
export function NextCallLine({
  slot,
  upcomingCalls,
  deliveryEngagementId,
}: Readonly<NextCallLineProps>): React.JSX.Element | null {
  const clock = useViewerClock();
  if (slot.kind !== 'upcoming') return null;
  return (
    <p className="text-muted-foreground text-[12.5px] leading-snug">
      Next call{' '}
      <WhenLabel call={slot.next} clock={clock} deliveryEngagementId={deliveryEngagementId} />
      {slot.more > 0 && (
        <>
          {' · '}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Show ${slot.more} more upcoming ${slot.more === 1 ? 'call' : 'calls'}`}
                className="text-primary focus-visible:ring-ring rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
              >
                +{slot.more} more
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-3">
              <PopoverTitle className="text-foreground mb-2 text-sm font-semibold">
                Upcoming calls
              </PopoverTitle>
              <ul className="space-y-1.5">
                {upcomingCalls.map((call) => (
                  <li
                    key={call.meetingId}
                    className="text-muted-foreground text-[12.5px] first-letter:uppercase"
                  >
                    <WhenLabel
                      call={call}
                      clock={clock}
                      deliveryEngagementId={deliveryEngagementId}
                    />
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </>
      )}
    </p>
  );
}
