'use client';

import { Loader2, PhoneOff } from 'lucide-react';
import type { MeetingExitReason } from '@/lib/meetings/meeting-route-context';
import { cn } from '@/lib/utils';

/**
 * BAL-435 — the frame's notices: the reconnect scrim, the inline pill, the presenting bar, the
 * polite announcer, and the TERMINAL "this call is over for you" card.
 *
 * ⚠ ONE MODULE so they do not become five near-identical blocks (SonarCloud's >3% duplication
 * gate on new code).
 */

export const RECONNECTING_TITLE = 'Reconnecting…';
export const RECONNECTING_BODY = "Your connection dropped. We're getting you back in.";
/** ⚠ After 20s the copy stops implying "any second now" and offers a way out. */
export const RECONNECTING_LONG_BODY =
  'Still trying. Your place in the call is held — nobody has to let you back in.';
export const RECONNECTING_LONG_AFTER_MS = 20_000;

export interface ReconnectingOverlayProps {
  readonly isLongWait: boolean;
  readonly onLeave: () => void;
}

/**
 * ⚠⚠ **THE LAST GOOD FRAME STAYS VISIBLE UNDERNEATH.** Never blank the video — the call may
 * recover in 800ms, and a blanked stage reads as "the call is over".
 *
 * ⚠ `motion-reduce:animate-none` on the spinner, which is precisely why the copy must never rely
 * on the spinner to mean "in progress".
 */
export function ReconnectingOverlay({
  isLongWait,
  onLeave,
}: Readonly<ReconnectingOverlayProps>): React.JSX.Element {
  return (
    <div className="bg-background/72 absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <Loader2
        className="text-foreground h-[30px] w-[30px] animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      <p className="text-foreground text-sm font-medium">{RECONNECTING_TITLE}</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {isLongWait ? RECONNECTING_LONG_BODY : RECONNECTING_BODY}
      </p>
      {isLongWait ? (
        <button
          type="button"
          onClick={onLeave}
          className="text-foreground focus-visible:ring-ring mt-1 inline-flex min-h-11 items-center rounded-lg px-3 text-[13px] font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Leave the call
        </button>
      ) : null}
    </div>
  );
}

export interface MeetingPillProps {
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly tone?: 'neutral' | 'warning';
}

/**
 * A short-lived inline pill under the top bar.
 *
 * ⚠ A PILL, NOT A TOAST. Toasts belong to MUTATIONS; joining a call is navigation, and a device
 * change is a fact about the browser rather than something the person just did.
 */
export function MeetingPill({
  message,
  actionLabel,
  onAction,
  tone = 'neutral',
}: Readonly<MeetingPillProps>): React.JSX.Element {
  return (
    <output
      className={cn(
        'mx-auto mt-2 flex w-fit max-w-full items-center gap-3 rounded-full px-4 py-1.5 text-xs',
        tone === 'warning' ? 'bg-warning/15 text-warning' : 'text-muted-foreground bg-white/6'
      )}
    >
      <span>{message}</span>
      {actionLabel === undefined || onAction === undefined ? null : (
        <button
          type="button"
          onClick={onAction}
          className="text-primary focus-visible:ring-ring rounded font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {actionLabel}
        </button>
      )}
    </output>
  );
}

/**
 * ⚠⚠ **THE POLITE LIVE REGION (§16).** One per frame, and the ONLY thing on this surface that
 * announces a change of state to a screen-reader user.
 *
 * Without it a person whose connection dropped got total silence — `ReconnectingOverlay`'s
 * spinner is `aria-hidden`, its copy is a plain `<p>`, and under `prefers-reduced-motion` it does
 * not even move — and then silence again on recovery. §13.3 makes the same region carry tile
 * join/leave when animation is suppressed, which is why it is not optional polish.
 *
 * ⚠ `<output>`, NOT `role="status"` (SonarCloud S6819 — use the native element), and NEVER an
 * `aria-busy` anywhere near it: that attribute SUPPRESSES the announcements this exists to make.
 * ⚠ THE CLOCK IS DELIBERATELY EXCLUDED. A duration announced every second is a denial of service.
 */
export function MeetingAnnouncer({ message }: Readonly<{ message: string }>): React.JSX.Element {
  return (
    <output aria-live="polite" className="sr-only">
      {message}
    </output>
  );
}

export const CALL_LEFT_TITLE = 'You’ve left the call';
export const CALL_LEFT_BODY = 'You can close this tab whenever you’re ready.';
export const CALL_ENDED_TITLE = 'The call has ended';

/** ⚠ ONE BUILDER PER REASON — a lookup, never a nested ternary (SonarCloud S3358). */
const ENDED_BODY: Record<MeetingExitReason, (contextNoun: string) => string> = {
  self: () => CALL_LEFT_BODY,
  host_ended: (contextNoun) =>
    `The host ended the call for everyone. Nothing is lost — the recap, notes and files all stay with the ${contextNoun}.`,
  // ⚠ The frame's fatal card owns a genuine error; this arm exists so the record is TOTAL and a
  // future reason cannot fall through to a blank card.
  error: () => 'The call has stopped. Nothing is lost — your meeting is still there.',
};

const ENDED_TITLE: Record<MeetingExitReason, string> = {
  self: CALL_LEFT_TITLE,
  host_ended: CALL_ENDED_TITLE,
  error: CALL_ENDED_TITLE,
};

export interface MeetingEndedNoticeProps {
  readonly reason: MeetingExitReason;
  readonly contextNoun: string;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}

/**
 * ⚠⚠ **THE TERMINAL STATE, AND IT IS A SECURITY CONTROL, NOT A COURTESY.**
 *
 * `left-meeting` and the Leave button both used to set `hasJoined = false` and nothing else,
 * which returned the frame to **PreJoin** — a live "Join now" button wired to `join()` with the
 * SAME still-valid token. Eject alone does not revoke a token (that is BAL-436's `ban: true`), so
 * "End for everyone" was undone by one click; and for anyone carrying the "Skip this next time"
 * preference the skip effect re-fired on that very state change and rejoined them **with no user
 * interaction at all**, camera and microphone on, while the host had already navigated away
 * believing the call was over.
 *
 * So this card renders INSTEAD of PreJoin once the frame is terminal, and it offers **no rejoin
 * affordance of any kind**. Coming back means a fresh navigation, which means a fresh
 * authorization at the api.
 *
 * ⚠ IT IS NOT BAL-389's END-OF-CALL SCREEN. On the member route `route.onExit` navigates and this
 * is never seen; it is what a GUEST sees, since a guest mount has no destination to be sent to.
 */
export function MeetingEndedNotice({
  reason,
  contextNoun,
  headingRef,
}: Readonly<MeetingEndedNoticeProps>): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="bg-muted/60 flex h-14 w-14 items-center justify-center rounded-full">
        <PhoneOff className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-lg font-semibold outline-none"
        >
          {ENDED_TITLE[reason]}
        </h1>
        <p className="text-muted-foreground mx-auto mt-1 max-w-[360px] text-sm leading-relaxed">
          {ENDED_BODY[reason](contextNoun)}
        </p>
      </div>
    </div>
  );
}

/** The persistent "you are presenting" bar above the toolbar. */
export function PresentingBar({ onStop }: Readonly<{ onStop: () => void }>): React.JSX.Element {
  return (
    <div className="border-border flex shrink-0 items-center justify-center gap-3 border-t px-4 py-2 text-xs">
      <span className="text-foreground font-medium">You&apos;re presenting</span>
      <button
        type="button"
        onClick={onStop}
        className="border-border text-destructive focus-visible:ring-ring inline-flex min-h-11 items-center rounded-lg border px-3 font-medium focus-visible:ring-2 focus-visible:outline-none"
      >
        Stop sharing
      </button>
    </div>
  );
}
