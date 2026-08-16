'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  DailyProvider,
  useActiveSpeakerId,
  useCallObject,
  useDaily,
  useDailyEvent,
  useLocalSessionId,
  useDevices,
  useMeetingState,
  useNetwork,
  useParticipantIds,
  useScreenShare,
} from '@daily-co/daily-react';
import { toast } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MEETING_CALL_EVENTS, MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import { orderTiles, type TileCandidate } from '@/lib/meetings/order-tiles';
import { isVideoLayout, resolveStageKind, type LayoutOverride } from '@/lib/meetings/resolve-stage';
import { useMeetingRoute, type MeetingExitReason } from '@/lib/meetings/meeting-route-context';
import { END_MEETING_FAILED_COPY } from '@/lib/meetings/meeting-state';
import type { MeetingPanelId, MeetingPanelRegistration } from '@/lib/meetings/meeting-panels';
import type { WaitingFacts, WaitingPhase, WaitingSubject } from '@/lib/meetings/waiting-copy';
import { useDrawdownPoll, type DrawdownPollState } from '@/lib/meetings/use-drawdown-poll';
import { resolveAutoOpen } from '@/lib/meetings/drawdown-auto-open';
import { InCallBalancePanel } from '@/components/balo/credit/in-call-balance-panel';
import type { MeetingFrameProps } from './meeting-frame-types';
import { JoinRetryNotice } from './join-notice-card';
import { BackToContextLink } from './back-to-context-link';
import { DeviceSettingsSheet } from './device-settings-sheet';
import { MeetingFrameElementProvider } from './meeting-frame-element';
import {
  MeetingAnnouncer,
  MeetingEndedNotice,
  MeetingPill,
  PresentingBar,
  RECONNECTING_LONG_AFTER_MS,
  ReconnectingOverlay,
} from './meeting-notices';
import { MeetingToolbar } from './meeting-toolbar';
import { MeetingTopBar, type MeetingRoster } from './meeting-top-bar';
import { PeoplePanel } from './people-panel';
import { FilesPanel } from './files-panel';
import { ChatPanel } from './chat-panel';
import { ReactionPicker } from './reaction-picker';
import { ReactionFloaters } from './reaction-floaters';
import { useMeetingCallRealtime, type MeetingCallRealtime } from './use-meeting-realtime';
import { PreJoin, readSkipPrejoin } from './prejoin';
import { StageContent } from './meeting-stage';
import { ViewControls } from './view-controls';
import { WaitingStage } from './waiting-stage';
import type { MeetingReactionEmoji } from '@/lib/meetings/meeting-reactions';

/**
 * BAL-435 — ⚠⚠ **THE DYNAMIC-IMPORT BOUNDARY. EVERY `@daily-co` IMPORT IN THE APP IS AT OR BELOW
 * THIS FILE.**
 *
 * `meeting-call-surface.tsx` imports NOTHING from `@daily-co`, value or type, and
 * `meeting-call-no-lens-gate.test.ts` pins that. The reason is not tidiness: two of the three
 * mounts are on the PUBLIC `/join/*` routes, so a static Daily import at the seam would drag the
 * whole vendor bundle into the initial chunk of an emailed link opened on a phone.
 *
 * ⚠ IT FOLLOWS THE REPO'S ONE EXISTING `next/dynamic` PRECEDENT VERBATIM — `rich-text-editor.tsx`
 * (a `'use client'` wrapper holding `dynamic(() => import('./x-impl'), { ssr:false, loading })`
 * with the implementation in a sibling `*-impl` file).
 *
 * ── ⚠⚠ THE GATE, RESTATED WHERE IT IS ENFORCED ──────────────────────────────────────────────
 *
 * `isOwner` arrives ALREADY DECIDED, server-side, per actor, from
 * `hasEngagementCapability(HOST_MEETINGS)`. **Nothing in this subtree re-derives it, and nothing
 * gates on a lens, `activeMode`, a role string or `platformRole`.**
 *
 * ⚠⚠ **BAL-134 / ADR-1049 SPLIT THAT BOOLEAN IN TWO, AND THIS FILE READS BOTH — FOR DIFFERENT
 * THINGS.** `grant.isOwner` is what minted the Daily OWNER TOKEN, so it stays exactly where it
 * describes the vendor relationship: the `is_owner` property on the JOINED analytics event, and
 * `participant-tile.tsx`'s host pill (which reads Daily's OWN per-participant `owner` flag, not
 * the grant at all). `grant.canEndMeeting` is `isOwner || clientPrincipal`, composed server-side
 * in `authorize-end-meeting.ts`, and it is the ONLY gate on ending the call for everyone —
 * because ADR-1049 gives end authority to the paying side too, and widening `isOwner` to say so
 * would hand a client a Daily owner token. **Never merge them.**
 *
 * ⚠ THE TOKEN AND THE ROOM URL NEVER LEAVE THIS FILE. They go into `daily.join()` and nowhere
 * else — not a log, not an analytics property, not a DOM attribute, not a URL.
 *
 * ⚠ `expiresAt` IS **NOT** USED FOR ANYTHING. `eject_at_token_exp` is false: an expiring token
 * does not eject anyone, it only prevents a fresh join. There is no countdown here and there
 * must never be one.
 *
 * ── ⚠⚠ THE TERMINAL LATCH — READ THIS BEFORE TOUCHING `exit`, `left-meeting` OR THE SKIP EFFECT ─
 *
 * Leaving is TERMINAL for this frame. `exit()` and the `left-meeting` handler both latch
 * `exitReason`, and while it is set the frame renders {@link MeetingEndedNotice} — never PreJoin.
 * Both previously only set `hasJoined = false`, which returned the frame to PreJoin's live "Join
 * now" button wired to `join()` with the SAME still-valid token; and because `hasJoined` is a
 * dependency of the skip-prejoin effect, anyone carrying the "Skip this next time" preference was
 * silently rejoined **within one render tick, with no interaction**, camera and microphone on.
 * That undid "End for everyone" (a client-side eject revokes no token — `ban:true` is BAL-444's)
 * while the host had already navigated away. `didAutoJoinRef` makes the skip a ONE-SHOT for the
 * life of the frame, which is the second, independent half of the same fix.
 */

/**
 * ⚠ THE ANALYTICS PROPERTIES SHARED BY EVERY EVENT ON THIS SURFACE, WHEN THE MEETING ID IS
 * UNKNOWN — i.e. on both ANONYMOUS guest mounts, which have no route context. The key is OMITTED
 * rather than sent as `null`: a key that is never set cannot create a bogus PostHog breakdown
 * bucket, and a `null` can.
 *
 * ⚠ GENUINELY FROZEN, not merely called frozen: it is spread into every event payload, and a
 * mutation would silently attach a property to every event on the surface.
 *
 * ⚠⚠ TYPED AS THE **EXACT SHAPE**, NEVER `Record<string, string>`. A `Record` index signature
 * defeats excess-property checking at every spread site, so the analytics event maps' PII
 * guard — the whole reason those maps enumerate their keys — stops applying the moment this
 * object is spread into a payload. A guest name or an address added here would then compile.
 */
const NO_MEETING_PROPS: Readonly<{ meeting_id?: string }> = Object.freeze({});

/** How long the "joined with your usual devices" pill stays up when PreJoin was skipped. */
const SKIP_NOTICE_MS = 4_000;
/** How long a transient device pill stays up. */
const DEVICE_NOTICE_MS = 6_000;

/** ⚠ §12.12 — the browser started refusing a device MID-CALL. A pill, never a modal. */
const CAMERA_BLOCKED_PILL = 'Your browser is blocking the camera. You can carry on with audio.';
const MIC_BLOCKED_PILL = 'Your browser is blocking the microphone. You can still see and listen.';
/**
 * ⚠ A DENIED SCREEN SHARE IS NOT A CANCELLED ONE. Cancelling a picker is silent, by design; a
 * REFUSAL (macOS screen-recording permission off — the common real case) previously left the
 * button simply not turning on, with no explanation anywhere.
 */
export const SCREENSHARE_BLOCKED_PILL =
  "We couldn't start screen sharing. Your browser or system settings may be blocking it.";

/** The polite announcements. ⚠ Facts, in words — never "the spinner is spinning". */
const ANNOUNCE_RECONNECTING = 'Reconnecting. Your connection dropped.';
const ANNOUNCE_RECONNECTED = 'You are back in the call.';
const ANNOUNCE_MUTED = 'You are muted.';
const ANNOUNCE_UNMUTED = 'Your microphone is on.';
const ANNOUNCE_JOINED = 'Someone joined the call.';
const ANNOUNCE_LEFT = 'Someone left the call.';

export function MeetingFrame(props: Readonly<MeetingFrameProps>): React.JSX.Element {
  /**
   * ⚠ ONE CALL OBJECT FOR THE PREVIEW **AND** THE JOIN. Created at provider mount so PreJoin's
   * camera preview and the join share it — which is what makes "Join now" a state transition
   * rather than a cold start, and is how the sub-three-second AC is met.
   */
  const callObject = useCallObject({});

  return (
    <DailyProvider callObject={callObject}>
      {/*
        ⚠⚠ `TooltipProvider` IS **NOT** MOUNTED AT THE APP ROOT (verified: the only three mounts
        in the whole app are local ones in the sidebar, the admin health panel and the expert
        card). Without this every icon-only control's tooltip silently does nothing — and every
        component test in this feature gets working tooltips for free because of it.
      */}
      <TooltipProvider delayDuration={0}>
        <MeetingFrameInner {...props} />
      </TooltipProvider>
    </DailyProvider>
  );
}

/** Local mic/camera intent, applied to Daily and used by the controls. */
function useLocalMedia(): {
  micOn: boolean;
  cameraOn: boolean;
  toggleMic: () => void;
  toggleCamera: () => void;
} {
  const daily = useDaily();
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);

  const toggleMic = useCallback((): void => {
    setMicOn((current) => {
      daily?.setLocalAudio(!current);
      return !current;
    });
  }, [daily]);

  const toggleCamera = useCallback((): void => {
    setCameraOn((current) => {
      daily?.setLocalVideo(!current);
      return !current;
    });
  }, [daily]);

  return { micOn, cameraOn, toggleMic, toggleCamera };
}

/**
 * Keep the phone awake for the duration of the call.
 *
 * ⚠ A PHONE SLEEPING MID-CALL IS THE MOST COMMON "the app dropped me" REPORT. Narrowed with
 * `'wakeLock' in navigator` so an unsupported browser is a SILENT NO-OP, never a thrown
 * rejection.
 */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (globalThis.navigator === undefined || !('wakeLock' in globalThis.navigator)) return;

    let released = false;
    let sentinel: WakeLockSentinel | null = null;
    globalThis.navigator.wakeLock
      .request('screen')
      .then((lock) => {
        if (released) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
      })
      .catch(() => {
        // A denied or unavailable wake lock is not an error the person needs to hear about.
      });

    return () => {
      released = true;
      sentinel?.release().catch(() => {});
    };
  }, [active]);
}

/**
 * §12.12 — a permission revoked mid-call.
 *
 * ⚠ THE TOOLBAR BUTTON ALREADY GOES `danger`; this adds the ONE sentence that says the browser
 * did it rather than the person. A pill, not a toast and not a modal: a degraded call is still a
 * call.
 */
function useDeviceBlockedNotice(meetingProps: Readonly<{ meeting_id?: string }>): string | null {
  const { camState, micState } = useDevices();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (camState !== 'blocked' && micState !== 'blocked') return;
    const kind = camState === 'blocked' ? 'camera' : 'microphone';
    setNotice(kind === 'camera' ? CAMERA_BLOCKED_PILL : MIC_BLOCKED_PILL);
    track(MEETING_CALL_EVENTS.DEVICE_BLOCKED, { ...meetingProps, kind });
    const timer = setTimeout(() => setNotice(null), DEVICE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [camState, micState, meetingProps]);

  return notice;
}

/** ⚠ Extracted so the frame's own component stays under the cognitive-complexity threshold. */
function useReconnectState(): { isReconnecting: boolean; isLongReconnect: boolean } {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isLongReconnect, setIsLongReconnect] = useState(false);
  const startedAtRef = useRef<number | null>(null);

  useDailyEvent(
    'network-connection',
    useCallback((event: { event: string }): void => {
      if (event.event === 'interrupted') {
        startedAtRef.current = Date.now();
        setIsReconnecting(true);
        return;
      }
      if (event.event === 'connected') {
        const startedAt = startedAtRef.current;
        if (startedAt !== null) {
          track(MEETING_CALL_EVENTS.RECONNECTED, {
            duration_ms: Date.now() - startedAt,
            recovered: true,
          });
        }
        startedAtRef.current = null;
        setIsReconnecting(false);
        setIsLongReconnect(false);
      }
    }, [])
  );

  useEffect(() => {
    if (!isReconnecting) return;
    const timer = setTimeout(() => setIsLongReconnect(true), RECONNECTING_LONG_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isReconnecting]);

  return { isReconnecting, isLongReconnect };
}

/**
 * ⚠⚠ **§16'S POLITE ANNOUNCEMENTS.** The reconnect overlay is visual-only (its spinner is
 * `aria-hidden` and stops moving entirely under `prefers-reduced-motion`), so without this a
 * screen-reader user whose connection dropped got silence, and silence again on recovery.
 * §13.3 also requires these to CARRY tile join/leave when animation is suppressed.
 *
 * ⚠ ONE STRING AT A TIME, and the clock is excluded on purpose — a duration announced every
 * second is a screen-reader denial of service (§10.5).
 *
 * ── ⚠⚠ BAL-436 — THE SIDE PANEL ANNOUNCES **THROUGH THIS HOOK**, NOT THROUGH A SECOND REGION ─
 *
 * The plan BANNED `aria-busy` on the panel because it suppresses "the live-region
 * announcement" — and then never specified a live region, leaving every panel component citing
 * one that did not exist. The only named vehicle was Sonner, which is a visual toast and was
 * additionally unreachable while the panel claimed `aria-modal` (that claim is now gone; see
 * `meeting-side-panel.tsx`).
 *
 * ⚠ THE FIX IS TO **EXTEND** THIS ONE, NOT TO ADD A SECOND. §16 says "the ONE polite live
 * region", and two `aria-live` regions on one surface race: a screen reader queues both and
 * the person hears the older message after the newer one. `announce` is therefore returned as
 * a plain setter and handed down to the panel, so admit/deny/invite/upload outcomes and a new
 * arrival in the queue all land in the SAME `<output>` the call itself uses.
 *
 * ⚠ THE PANEL'S MESSAGES COMPETE WITH THE CALL'S, AND THE CALL WINS BY RECENCY ONLY — there is
 * no priority queue, deliberately. A panel outcome is user-initiated and instant; a reconnect
 * is not. Interleaving them by "most recent wins" is what a person actually needs, and a
 * priority scheme would be one more thing to get wrong on a live call.
 */
function useCallAnnouncement(input: {
  readonly hasJoined: boolean;
  readonly isReconnecting: boolean;
  readonly remoteCount: number;
  readonly micOn: boolean;
}): { readonly message: string; readonly announce: (message: string) => void } {
  const { hasJoined, isReconnecting, remoteCount, micOn } = input;
  const [message, setMessage] = useState('');
  const previousRemotes = useRef(remoteCount);
  const previousMic = useRef(micOn);
  const wasReconnecting = useRef(false);

  useEffect(() => {
    if (isReconnecting) {
      wasReconnecting.current = true;
      setMessage(ANNOUNCE_RECONNECTING);
      return;
    }
    if (wasReconnecting.current) {
      wasReconnecting.current = false;
      setMessage(ANNOUNCE_RECONNECTED);
    }
  }, [isReconnecting]);

  useEffect(() => {
    const previous = previousRemotes.current;
    previousRemotes.current = remoteCount;
    if (!hasJoined || remoteCount === previous) return;
    setMessage(remoteCount > previous ? ANNOUNCE_JOINED : ANNOUNCE_LEFT);
  }, [hasJoined, remoteCount]);

  useEffect(() => {
    if (previousMic.current === micOn) return;
    previousMic.current = micOn;
    setMessage(micOn ? ANNOUNCE_UNMUTED : ANNOUNCE_MUTED);
  }, [micOn]);

  /**
   * ⚠ RE-ANNOUNCE THE SAME SENTENCE. Two identical admits in a row must both be heard, and a
   * live region only fires on a CHANGE — so an unchanged string is silence. The zero-width
   * space alternates the text node's content without altering how it is read aloud, which is
   * the standard answer and is cheaper than a keyed remount of the region.
   */
  const announce = useCallback((next: string): void => {
    // ⚠ WRITTEN AS AN ESCAPE, NEVER AS THE LITERAL CHARACTER — an invisible code point pasted
    // into source is unreviewable and the next reader deletes it as a typo.
    setMessage((current) => (current === next ? `${next}\u200B` : next));
  }, []);

  return { message, announce };
}

/**
 * BAL-436 — ⚠⚠ **ONE** SEAT READ, ON JOIN. Not a poll.
 *
 * ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────────────────
 *
 * `PeoplePanel` was the seat count's only writer, so the top-bar chip did not render until the
 * People panel had been opened once — and the chip is itself the affordance for opening People.
 * Discovery was therefore circular: the control that reveals the roster was hidden until you had
 * already reached the roster some other way (the More sheet, or a toolbar button that only
 * exists at `lg`). One read on join breaks the loop, and the chip then survives the panel
 * closing because the state lives in the frame.
 *
 * ── ⚠ WHY IT IS NOT A POLL, AND MUST NOT BECOME ONE ─────────────────────────────────────
 *
 * Seats change on invite / admit / revoke — all of which happen INSIDE the panel, which
 * refetches after every mutation and hands the result back through the same setter. A
 * permanently-polling top bar would defeat the panel's own "closed ⇒ paused" rule, which is the
 * whole cadence bound (Ruling E). This runs exactly once per frame.
 *
 * ⚠ A FAILURE IS SILENT. The chip is `null` until a count exists, which renders NOTHING — an
 * unavailable count is not a count, and there is no error state to show for a decoration on a
 * live call. `getMeetingGuestsAction` already logs the refusal server-side at `warn`.
 *
 * ⚠ UNREGISTERED ⇒ NO READ AT ALL. `panels === null` on both GUEST mounts, structurally, and
 * neither could satisfy `requireUser()` anyway.
 */
function useSeatCountOnJoin(input: {
  readonly panels: MeetingPanelRegistration | null;
  readonly hasJoined: boolean;
  readonly onSeats: (seats: MeetingRoster) => void;
}): void {
  const { panels, hasJoined, onSeats } = input;
  /** ⚠ A ONE-SHOT LATCH, so a re-render or a reconnect cannot re-fire the read. */
  const hasReadRef = useRef(false);

  useEffect(() => {
    if (!hasJoined || panels === null || hasReadRef.current) return;
    hasReadRef.current = true;
    void panels.loadGuests().then((result) => {
      if (!result.success) return;
      onSeats({
        participantCount: result.data.participantCount,
        participantCap: result.data.participantCap,
      });
    });
  }, [hasJoined, panels, onSeats]);
}

/**
 * ⚠⚠ CAPABILITY, NOT BREAKPOINT. `getDisplayMedia` does not exist on iOS Safari or Android
 * Chrome, so on essentially every phone the "Share screen" row was a tap that produced no picker,
 * no state change and no message — worse than the greyed-out icon the slot rule forbids, because
 * it looked live. Probed in an effect so the SSR/first-paint answer is never used.
 */
function useScreenShareSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const devices = globalThis.navigator?.mediaDevices as { getDisplayMedia?: unknown } | undefined;
    setSupported(typeof devices?.getDisplayMedia === 'function');
  }, []);
  return supported;
}

/** §13.1 — one entrance step. ⚠ Reduced motion collapses every step to a 150ms fade, no stagger. */
function entrance(
  reduceMotion: boolean,
  from: { readonly y?: number; readonly scale?: number },
  delay: number
): {
  initial: Record<string, number>;
  animate: Record<string, number>;
  transition: { duration: number; delay: number; ease: 'easeOut' };
} {
  if (reduceMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: 0.15, delay: 0, ease: 'easeOut' },
    };
  }
  return {
    initial: { opacity: 0, ...from },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: 0.25, delay, ease: 'easeOut' },
  };
}

interface FrameChromeInput {
  readonly hasFailed: boolean;
  /** ⚠ NULLABLE — `useMeetingState()` returns `null` before the call object reports one. */
  readonly meetingState: string | null;
  readonly exitReason: MeetingExitReason | null;
  readonly kind: ReturnType<typeof resolveStageKind>;
  readonly headingRef: React.Ref<HTMLHeadingElement> | undefined;
}

interface FrameChrome {
  readonly isFatal: boolean;
  readonly showChrome: boolean;
  readonly topBarHeadingRef: React.Ref<HTMLHeadingElement> | undefined;
}

/**
 * ⚠⚠ EXACTLY ONE `<h1>` PER STATE, AND `headingRef` GOES TO IT. The top bar owns the heading on
 * the live stage; PreJoin, the waiting stage, the terminal card and the fatal card each own their
 * own — so the bar is suppressed on those states and its ref is withheld on the waiting one.
 *
 * ⚠ A PURE MODULE HELPER RATHER THAN FOUR INLINE `const`s, ONLY TO SHED COGNITIVE COMPLEXITY.
 * SonarCloud scores the COMPONENT BODY's own conditionals (a nested `useCallback` is scored
 * separately, so extracting handlers would not have helped), and these four booleans were the
 * bulk of them — 18 against the allowed 15. The logic is unchanged, line for line.
 */
function resolveFrameChrome({
  hasFailed,
  meetingState,
  exitReason,
  kind,
  headingRef,
}: Readonly<FrameChromeInput>): FrameChrome {
  const isFatal = hasFailed || meetingState === 'error';
  // ⚠ THE TERMINAL LATCH, read here only to suppress chrome. The component itself branches on
  // `exitReason` directly, so this stays local rather than joining the returned shape.
  const isTerminal = exitReason !== null;
  const showChrome = !isFatal && !isTerminal && kind !== 'prejoin';
  const topBarHeadingRef = showChrome && kind !== 'waiting' ? headingRef : undefined;
  return { isFatal, showChrome, topBarHeadingRef };
}

interface PanelSlotsInput {
  readonly panels: MeetingPanelRegistration | null;
  readonly panel: MeetingPanelId | null;
  readonly seats: MeetingRoster | null;
  readonly togglePanel: (id: MeetingPanelId) => void;
  readonly peopleButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly filesButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly chatButtonRef: React.RefObject<HTMLButtonElement | null>;
  /** BAL-437 — set while a message arrived with the Chat panel closed. */
  readonly unreadChat: boolean;
  /** BAL-437 — the desktop picker, or `null` when realtime is unconfigured. */
  readonly reactionControl: React.ReactNode | null;
  /** BAL-437 — opens the picker from the MoreSheet's mobile row. `null` ⇒ no row. */
  readonly onOpenReactions: (() => void) | null;
  /** BAL-403 — the Balance slot's own opener button ref. */
  readonly balanceButtonRef: React.RefObject<HTMLButtonElement | null>;
  /** BAL-403 — set by the auto-open ladder while an escalation could not steal an open panel. */
  readonly balanceAttention: boolean;
}

interface PanelSlots {
  /** Spread onto the top bar and onto `StageContent`. Empty ⇒ neither becomes interactive. */
  readonly openPeopleSlot: { onOpenPeople?: () => void };
  /** Spread onto the toolbar. Empty ⇒ no People/Files buttons and no MoreSheet rows. */
  readonly toolbarPanelSlot: {
    openPanel?: MeetingPanelId | null;
    onTogglePanel?: (id: MeetingPanelId) => void;
    peopleButtonRef?: React.RefObject<HTMLButtonElement | null>;
    filesButtonRef?: React.RefObject<HTMLButtonElement | null>;
    chatButtonRef?: React.RefObject<HTMLButtonElement | null>;
    hasChat?: boolean;
    unreadChat?: boolean;
    reactionControl?: React.ReactNode;
    onOpenReactions?: () => void;
    balanceButtonRef?: React.RefObject<HTMLButtonElement | null>;
    hasBalance?: boolean;
    balanceAttention?: boolean;
  };
  /** ⚠ THE SEAT CHIP. `null` ⇒ the whole chip is absent — an unavailable count is not a count. */
  readonly roster: MeetingRoster | null;
}

/**
 * BAL-436 — ⚠⚠ **"REGISTERED OR ABSENT", RESOLVED ONCE.**
 *
 * Four surfaces ask the same question (the top bar's chip, the stage's overflow tile, the
 * toolbar's two buttons, the MoreSheet's two rows), and asking it four times inline meant four
 * conditional spreads sitting inside JSX ternaries — which SonarCloud reads as NESTED
 * conditionals (S3358) and which pushed the component body to 27 against the allowed 15.
 *
 * ⚠ A PURE MODULE HELPER RATHER THAN INLINE `const`s, exactly as `resolveFrameChrome` is, and
 * for exactly the same reason. The logic is unchanged.
 *
 * ⚠ THERE IS NO LENS, ROLE OR MODE ANYWHERE IN HERE. The only input is whether the route
 * mounted a registration, which both GUEST mounts structurally do not.
 */
function resolvePanelSlots({
  panels,
  panel,
  seats,
  togglePanel,
  peopleButtonRef,
  filesButtonRef,
  chatButtonRef,
  unreadChat,
  reactionControl,
  onOpenReactions,
  balanceButtonRef,
  balanceAttention,
}: Readonly<PanelSlotsInput>): PanelSlots {
  if (panels === null) {
    return { openPeopleSlot: {}, toolbarPanelSlot: {}, roster: null };
  }
  return {
    openPeopleSlot: { onOpenPeople: () => togglePanel('people') },
    toolbarPanelSlot: {
      openPanel: panel,
      onTogglePanel: togglePanel,
      peopleButtonRef,
      filesButtonRef,
      chatButtonRef,
      // ⚠ BAL-437 — THREE INDEPENDENT REGISTRATIONS, NOT ONE. `panels !== null` gets you
      // People and Files; `panels.chat !== null` gets you Chat; `panels.realtime !== null`
      // gets you Reactions. A call can legitimately have the first without either of the
      // others — an `admin` meeting has no conversation anchor, and a dev box has no
      // `ABLY_API_KEY`. Collapsing them would ship a control that could only ever fail.
      hasChat: panels.chat !== null,
      unreadChat,
      ...(reactionControl === null ? {} : { reactionControl }),
      ...(onOpenReactions === null ? {} : { onOpenReactions }),
      // BAL-403 — a FOURTH independent registration. `false` for every meeting today (see
      // `meeting-panels.ts`), which is the expected, inert answer — no toolbar button, no
      // More-sheet row.
      balanceButtonRef,
      hasBalance: panels.balance !== null,
      balanceAttention,
    },
    roster: seats,
  };
}

/**
 * BAL-437 — ⚠⚠ **THE ONE ABLY CLIENT FOR THE WHOLE CALL, PLUS THE REACTIONS SLOT.**
 *
 * Mounted at frame level rather than in the Chat panel because reactions float over the STAGE
 * while the panel is closed, the Files panel needs the same connection, and inbound chat must
 * be buffered while the panel is unmounted. `panels?.realtime ?? null` ⇒ no key configured ⇒
 * terminal `'disabled'`: no client, no retry loop, and NO Reactions control.
 *
 * ⚠ A HOOK RATHER THAN INLINE STATE, ONLY TO SHED COGNITIVE COMPLEXITY — inline,
 * `MeetingFrameInner`'s own body scored 29 against SonarCloud's allowed 15. The repo's
 * precedent is to EXTRACT, never to disable the rule (`useMeetingPanel` was split out for
 * exactly this).
 *
 * ⚠ A TERMINAL FRAME CLOSES THE PICKER, for the same reason it closes the panel: a call that
 * has ended must not keep a live control on screen. The floaters need no unwinding — each is
 * on its own 2.2s timer.
 */
function useCallRealtimeSlot(input: {
  readonly panels: MeetingPanelRegistration | null;
  readonly panel: MeetingPanelId | null;
  readonly isTerminal: boolean;
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
  /** §16's ONE polite live region, so a failed reaction is HEARD as well as seen. */
  readonly announce: (message: string) => void;
  /**
   * BAL-437 — the More trigger, focused when the picker closes ON MOBILE.
   *
   * ⚠⚠ BELOW 768px THE PICKER'S OWN TRIGGER IS `display: none` (`hidden md:flex`) AND THE MENU
   * IS A RADIX **DIALOG**, so Radix's default focus restore targets a hidden node and focus
   * falls to `<body>` — a keyboard or screen-reader user is dumped out of the toolbar mid-call.
   * The mobile opener is the More button, so that is where focus must go back to.
   */
  readonly moreButtonRef: React.RefObject<HTMLButtonElement | null>;
}): {
  readonly realtime: MeetingCallRealtime;
  /** ⚠ `null` ⇒ NO REACTIONS CONTROL AT ALL. Absent, never disabled. */
  readonly reactionControl: React.ReactNode | null;
  readonly onOpenReactions: (() => void) | null;
} {
  const { panels, panel, isTerminal, meetingProps, announce, moreButtonRef } = input;
  const [reactionsOpen, setReactionsOpen] = useState(false);

  const onReactionSent = useCallback(
    (emoji: MeetingReactionEmoji, outcome: 'ok' | 'failed'): void => {
      // ⚠ THE GLYPH AND AN OUTCOME. Never a sender, never the nonce.
      track(MEETING_PANEL_EVENTS.REACTION_SENT, { ...meetingProps, emoji, outcome });
    },
    [meetingProps]
  );

  /**
   * ⚠⚠ A **USER-FACING** REPORT, WHICH `onReactionSent` IS NOT. That one feeds PostHog. This one
   * exists because the optimistic float has already risen by the time a send fails, so silence
   * means the sender believes the room saw it. Toast AND the §16 region, one sentence in both —
   * the same pairing every panel's `report` uses.
   */
  const onReactionError = useCallback(
    (message: string): void => {
      toast.error(message);
      announce(message);
    },
    [announce]
  );

  const realtime = useMeetingCallRealtime({
    registration: panels?.realtime ?? null,
    isChatOpen: panel === 'chat',
    onReactionSent,
    onReactionError,
  });

  useEffect(() => {
    if (isTerminal) setReactionsOpen(false);
  }, [isTerminal]);

  const openReactions = useCallback((): void => setReactionsOpen(true), []);

  // ⚠ EVERY HOOK ABOVE RUNS UNCONDITIONALLY; only the RETURN branches.
  if (panels?.realtime == null) {
    return { realtime, reactionControl: null, onOpenReactions: null };
  }
  return {
    realtime,
    reactionControl: (
      <ReactionPicker
        open={reactionsOpen}
        onOpenChange={setReactionsOpen}
        onSelect={realtime.sendReaction}
        mobileOpenerRef={moreButtonRef}
      />
    ),
    onOpenReactions: openReactions,
  };
}

/** §16's polite announcements for a background escalation. See `useDrawdownBalanceSlot`. */
const ANNOUNCE_BALANCE_OPENED = 'Your balance needs attention. The Balance panel has opened.';
const ANNOUNCE_BALANCE_BADGE = 'Your balance needs attention.';

/**
 * BAL-403 — the drawdown poll plus the auto-open ladder, composed into one hook.
 *
 * ⚠ A HOOK RATHER THAN INLINE STATE, ONLY TO SHED COGNITIVE COMPLEXITY — the same reason
 * `useCallRealtimeSlot` and `useMeetingPanel` are hooks rather than inline `MeetingFrameInner`
 * logic. The repo's precedent is to EXTRACT, never to disable the SonarCloud rule.
 *
 * ⚠⚠ THE LADDER EFFECT DELIBERATELY DEPENDS ONLY ON `[key, isTerminal]`, NOT ON `panel` /
 * `openPanel` / `closePanel`. Those are read from the closure at DECISION TIME (i.e. as of the
 * render that changed `key` or `isTerminal`, which is exactly the panel state that matters), and
 * including them would re-run the ladder's decision on every unrelated panel toggle — which
 * `resolveAutoOpen`'s own contract forbids (it acts ONLY on an escalation in `key`).
 *
 * ── ⚠⚠ FIX ROUND 1 (W5) — `autoOpened` + THE LIVE-REGION ANNOUNCEMENT ─────────────────────────
 *
 * `MeetingSidePanel`'s mount effect used to steal focus unconditionally, which was correct for
 * every open until this ladder's `'open'` decision started firing it from a background poll. An
 * auto-open now announces `ANNOUNCE_BALANCE_OPENED` through the frame's own §16 live region
 * INSTEAD of moving focus (`autoOpened` tells `MeetingSidePanel` to skip the move), and the
 * ladder's `togglePanel` is WRAPPED so any MANUAL toggle clears `autoOpened` before the panel
 * state itself changes — a click always restores the shipped focus-on-open behaviour.
 *
 * A `'badge'` decision never opens anything, so there was previously NO audible signal at all
 * for it — a purely visual dot. The first badge escalation PAST `low` (rank ≥ 2: near / grace /
 * wrap / end) now announces once too: a funding interruption is higher-stakes than an unread
 * chat message, and the region already exists. `low` itself stays silent, matching its own
 * visual treatment (a dot, not urgent copy).
 *
 * ── ⚠⚠ FIX ROUND 2 (R5) — `announcedBadgeRef` RE-ARMS ON DE-ESCALATION ─────────────────────────
 *
 * Round 1 set the ref once and never cleared it, so it fired for the FIRST badge escalation past
 * `low` and stayed silent for every one after — including a SECOND, worse escalation following a
 * de-escalation (e.g. an admin top-up brings the session back to `healthy`, then it drains
 * again). Rule 6 of the ladder is explicit that a second drain is a second event worth
 * surfacing; the visual dot already re-arms with `highestRankRef` resetting on de-escalation, so
 * the audible half now mirrors it — reset alongside the rank, not independently of it.
 *
 * ── ⚠⚠ FIX ROUND 2 (R3) — THE VANISH-CLOSE EFFECT ONLY CLOSES ON A VANISH, NEVER ON A DENIAL ───
 *
 * `useDrawdownPoll`'s W2 fix clears `state` to `null` on BOTH a genuine vanish (session
 * soft-deleted / cancelled mid-call, `status: 'ready'`) AND a non-retryable failure
 * (`status: 'error'`) — the two are deliberately the same `state: null` shape so a caller cannot
 * distinguish "gone" from "failed" by inspecting `state` alone; `status` is what disambiguates.
 * Round 1's vanish-close effect keyed on `state` alone, so it closed the OPEN panel unconditionally
 * on both — but this effect has `panel` in its dependency list, and it re-runs on every render
 * that changes `panel`, so a re-open attempt after such a failure closed AGAIN on the very
 * next tick, before the error card could ever mount: healthy → open → failed → forced closed →
 * click the (still-present) toolbar button → reopens → closes again, forever, with no card and
 * no way back.
 *
 * ⚠ `status: 'error'` (`retryable: false`) is NOT a membership denial — `get-meeting-drawdown-
 * state.ts` only emits it when `enterCallAction` itself fails (an expired session, or an invalid
 * `meetingId`). A membership / audience denial goes through `resolveInCallDrawdown` returning
 * `null`, which the action folds into the SAME `{ success: true, state: null }` shape as a
 * genuine vanish — i.e. it arrives on THIS effect's `status === 'ready'` arm, not on `'error'`.
 *
 * ⚠ THE GUARD IS `drawdown.status !== 'ready'` — A POSITIVE CHECK ON THE ONE STATUS A VANISH
 * ACTUALLY CARRIES, NOT A NEGATIVE CHECK EXCLUDING `'error'`. An `status !== 'error'` guard is
 * NOT the same claim and is itself broken: `useDrawdownPoll`'s `retry()` flips `status` to
 * `'loading'` BEFORE its fetch resolves, with `state` still `null` — so clicking the error
 * card's OWN "Try again" button would re-arm this effect (loading ≠ error) and close the panel
 * out from under the very click meant to recover it, a second dead-control regression inside
 * the fix for the first one. `'ready'` is the ONE status `useDrawdownPoll`'s `applyResult` ever
 * pairs with a `state: null` SUCCESS, so it is the only status that may close the panel; both
 * `'loading'` (a fetch in flight, retried or not) and `'error'` (an expired session / invalid
 * `meetingId`) must leave it open so `InCallBalancePanel` renders its error card, with a working
 * retry (see R4).
 */
function useDrawdownBalanceSlot(input: {
  readonly panels: MeetingPanelRegistration | null;
  readonly panel: MeetingPanelId | null;
  readonly isTerminal: boolean;
  readonly openPanel: (id: MeetingPanelId) => void;
  readonly closePanel: () => void;
  readonly togglePanel: (id: MeetingPanelId) => void;
  /** §16's ONE polite live region. */
  readonly announce: (message: string) => void;
}): {
  readonly drawdown: DrawdownPollState;
  /** `true` while an escalation could not steal an open panel. Cleared by opening Balance. */
  readonly attention: boolean;
  /** BAL-403 fix round 1 (W5) — `true` while the OPEN Balance panel was opened by the ladder. */
  readonly autoOpened: boolean;
  /** Wraps the frame's `togglePanel`, clearing `autoOpened` on every MANUAL toggle. */
  readonly togglePanel: (id: MeetingPanelId) => void;
} {
  const { panels, panel, isTerminal, openPanel, closePanel, togglePanel, announce } = input;
  const drawdown = useDrawdownPoll({ balance: panels?.balance ?? null });
  const highestRankRef = useRef(0);
  const [attention, setAttention] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  /** ⚠ ONLY A SESSION THAT WAS ONCE REAL may auto-close the panel on vanishing — the ordinary
   * `state: null` before the first poll lands must not be mistaken for a vanished one. */
  const hadStateRef = useRef(false);
  /**
   * ⚠⚠ FIX ROUND 3 — THE VANISH-CLOSE LATCH. Without this, the effect below re-fires on every
   * render that flips `panel` back to `'balance'` (it is in the dependency list), so a
   * deliberate re-open after a vanish force-closes the panel again in the same commit — the
   * Balance control is still registered (`hasBalance` never clears), so the toolbar button and
   * More-sheet row survive the vanish, but clicking either one mounts and immediately unmounts
   * the panel, bouncing focus back to the button with nothing to show for it. The latch makes
   * the auto-close a ONE-TIME reaction to the vanish itself, not a standing veto on the panel
   * ever being 'balance' again while `state` stays null: it fires once, then a re-open renders
   * `BalanceUnavailableCard` like any other terminal read. It re-arms only when a fresh real
   * state lands (the `drawdown.state !== null` branch below), i.e. a genuinely new vanish.
   */
  const vanishClosedRef = useRef(false);
  /** W5 — announce the badge escalation ONCE, the first time it crosses past `low`. */
  const announcedBadgeRef = useRef(false);

  const key = drawdown.state?.key ?? null;
  useEffect(() => {
    const result = resolveAutoOpen({
      key,
      highestRank: highestRankRef.current,
      openPanel: panel,
      isTerminal,
    });
    // ⚠⚠ R5 — RE-ARM THE BADGE ANNOUNCEMENT ON DE-ESCALATION, mirroring the visual dot's own
    // `highestRankRef` reset. A rank that fell back below the announce threshold means the NEXT
    // crossing past it is a fresh event, not a repeat of one already announced.
    if (result.highestRank < 2) {
      announcedBadgeRef.current = false;
    }
    highestRankRef.current = result.highestRank;
    if (result.decision === 'open') {
      setAutoOpened(true);
      openPanel('balance');
      setAttention(false);
      // ⚠ INSTEAD OF FOCUS, NOT IN ADDITION TO IT — `MeetingSidePanel` withholds the move for
      // this mount because `autoOpened` is `true`.
      announce(ANNOUNCE_BALANCE_OPENED);
    } else if (result.decision === 'badge') {
      setAttention(true);
      if (result.highestRank >= 2 && !announcedBadgeRef.current) {
        announcedBadgeRef.current = true;
        announce(ANNOUNCE_BALANCE_BADGE);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isTerminal]);

  // ⚠ THE BADGE IS THE DEFERRED OPEN — it clears whenever Balance is opened, by ANY route
  // (toolbar, More sheet, or the ladder's own `'open'` decision above). It does NOT clear on a
  // further escalation while still closed; `resolveAutoOpen` keeps re-raising it instead.
  //
  // ⚠⚠ W5 — THE SAME EFFECT RESETS `autoOpened` THE MOMENT THE PANEL ISN'T BALANCE. A manual
  // toggle already clears it synchronously (see `handleTogglePanel` below); this is the
  // fail-safe for every OTHER path that changes `panel` (Escape, the close button, a terminal
  // frame) so a stale `true` can never leak into a later open this effect did not decide.
  useEffect(() => {
    if (panel === 'balance') {
      setAttention(false);
    } else {
      setAutoOpened(false);
    }
  }, [panel]);

  // ⚠⚠ THE SESSION VANISHED MID-CALL — a SUCCESS with `state: null` after having had a real one.
  // The frame closes the panel itself; `InCallBalancePanel` never needs to render that case.
  //
  // ⚠⚠ R3 — CLOSE ONLY ON `status === 'ready'` — A POSITIVE CHECK, NOT `!== 'error'`. `state:
  // null` alone cannot tell a genuine vanish (`status: 'ready'`, `useDrawdownPoll`'s success-
  // answering-null arm) apart from a fail-closed DENIAL (`status: 'error'`, the W2 arm) — only
  // `status` does. The first attempt at this fix used `status !== 'error'`, which is NOT the
  // same claim: `retry()` flips `status` to `'loading'` BEFORE its fetch resolves, with `state`
  // still `null` — so clicking the error card's own "Try again" re-armed this effect and closed
  // the panel out from under the click that was supposed to recover it. `'ready'` is the ONE
  // status `applyResult` ever pairs with a `state: null` SUCCESS; `'loading'` and `'error'` must
  // both leave the panel open.
  useEffect(() => {
    if (drawdown.state !== null) {
      hadStateRef.current = true;
      vanishClosedRef.current = false;
      return;
    }
    if (!hadStateRef.current || panel !== 'balance') return;
    if (drawdown.status !== 'ready') return;
    // ⚠⚠ FIX ROUND 3 — LATCHED. Without this guard, re-opening Balance after a vanish flips
    // `panel` back to `'balance'`, this effect re-runs (it's in the deps below), and it closes
    // the panel again before `BalanceUnavailableCard` can ever render — a dead control for the
    // rest of the call. One close per vanish; see the ref's docblock above.
    if (vanishClosedRef.current) return;
    vanishClosedRef.current = true;
    closePanel();
  }, [drawdown.state, drawdown.status, panel, closePanel]);

  /**
   * W5 — the MANUAL entry point. Clearing `autoOpened` here, BEFORE `togglePanel` flips `panel`,
   * is what makes a click on the Balance button (or its badge) restore focus-on-open even when
   * the panel was already open via the ladder.
   */
  const handleTogglePanel = useCallback(
    (id: MeetingPanelId): void => {
      setAutoOpened(false);
      togglePanel(id);
    },
    [togglePanel]
  );

  return { drawdown, attention, autoOpened, togglePanel: handleTogglePanel };
}

function MeetingFrameInner({ grant, headingRef }: Readonly<MeetingFrameProps>): React.JSX.Element {
  const daily = useDaily();
  const route = useMeetingRoute();
  const meetingState = useMeetingState();
  const localSessionId = useLocalSessionId();
  const activeSpeakerId = useActiveSpeakerId();
  // ⚠ SORTED BY `joined_at` BY DAILY ITSELF, so tile ordering needs no per-participant hook.
  const participantIds = useParticipantIds({ sort: 'joined_at' });
  const { isSharingScreen, screens, startScreenShare, stopScreenShare } = useScreenShare();
  const { networkState } = useNetwork();
  const { micOn, cameraOn, toggleMic, toggleCamera } = useLocalMedia();
  const { isReconnecting, isLongReconnect } = useReconnectState();
  const canShareScreen = useScreenShareSupported();
  const reduceMotion = useReducedMotion() === true;

  const [frameElement, setFrameElement] = useState<HTMLElement | null>(null);
  const [hasJoined, setHasJoined] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  /**
   * ⚠⚠ THE TERMINAL LATCH. Non-null ⇒ this frame is over: no PreJoin, no auto-join, no rejoin.
   * See the module docblock — it is a security control, not a courtesy.
   */
  const [exitReason, setExitReason] = useState<MeetingExitReason | null>(null);
  const [override, setOverride] = useState<LayoutOverride>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  /**
   * The SEAT counts for the top-bar chip, hoisted out of the panel so the chip SURVIVES the
   * panel closing. ⚠ THE SERVER'S counter, never a local tile count — the two differ.
   *
   * ⚠⚠ **SEEDED ONCE ON `hasJoined`, NOT ONLY BY THE PANEL.** While the panel was its only
   * writer the chip did not exist until People had been opened — and the chip is ALSO the
   * affordance for opening People, so discovery was circular: the one control that reveals the
   * roster was hidden until you had already found the roster another way. One read on join
   * breaks the loop. See `useSeatCountOnJoin`; it does NOT poll (that is the panel's job, and
   * only while the panel is open).
   */
  const [seats, setSeats] = useState<MeetingRoster | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [selfIsPrimary, setSelfIsPrimary] = useState(false);
  const [pill, setPill] = useState<string | null>(null);
  const joinStartedAtRef = useRef<number | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const shareStartedAtRef = useRef<number | null>(null);
  /** ⚠ The skip decision, captured at the moment it is MADE. See `prejoin_skipped` below. */
  const didAutoJoinRef = useRef(false);
  /** We asked to leave ⇒ a following `left-meeting` is ours, not an eject. */
  const leaveRequestedRef = useRef(false);
  /** The latch, as a ref too, so callbacks fired in the same tick cannot double-exit. */
  const hasExitedRef = useRef(false);

  /**
   * ⚠⚠ THE ANALYTICS KEY IS `meeting_id` (snake_case, the repo convention) AND IT IS **OMITTED
   * ENTIRELY** WHEN UNKNOWN — spread, never set to `null`. A key that is never set cannot create
   * a bogus breakdown bucket; a `null` reaches PostHog as a real value that does. Same reasoning
   * as `guest_joined`'s conditionally-spread `party`.
   */
  const meetingProps = useMemo((): Readonly<{ meeting_id?: string }> => {
    const id = route.meetingId;
    // ⚠ THE SHARED FROZEN EMPTY OBJECT, not a fresh `{}` — an inline literal would give the memo
    // a new identity on every recompute.
    if (id === null) return NO_MEETING_PROPS;
    return { meeting_id: id };
  }, [route.meetingId]);
  const deviceNotice = useDeviceBlockedNotice(meetingProps);

  /**
   * ⚠ THE PREVIEW STARTS ON MOUNT, NOT ON "JOIN NOW". It shares the call object with the join,
   * so pressing Join is a transition rather than a cold start.
   */
  useEffect(() => {
    if (daily === null) return;
    daily.startCamera().catch(() => {
      // A blocked or missing camera is a STATE, not a failure — PreJoin renders it and Join
      // stays enabled, because audio-only is a valid call.
    });
  }, [daily]);

  const join = useCallback((): void => {
    if (daily === null || isJoining) return;
    setIsJoining(true);
    joinStartedAtRef.current = Date.now();
    daily
      .join({
        // ⚠ THE VALIDATED URL AND TOKEN. They go here and NOWHERE else.
        url: grant.roomUrl,
        token: grant.token,
        // ⚠⚠ NO `userName` IS SENT. The server-minted token's `user_name` claim is authoritative;
        // a client-supplied name on a private room is the impersonation surface PreJoin refuses.
        // ⚠⚠ AND NO `userData` EITHER. It carried `{ participantId }`, which IS the raw Balo
        // `users.id` (Decision-1 encodes it as `'u'` + 32 hex) — and Daily syncs `userData` to
        // every participant in the room, including anonymous lobby guests. NOTHING consumed it
        // (`meeting-presence.ts` states identity comes from the token claim and "never from Daily
        // userData"), so it was a second, needless channel for an internal identifier. If a
        // client-side signal is ever needed, read the `user_id` claim Daily already decodes.
      })
      .then(() => {
        setHasJoined(true);
        callStartedAtRef.current = Date.now();
        // ⚠ THE PILL APPEARS WHEN THE JOIN **RESOLVES**, NOT WHEN IT STARTS. Announcing "Joined
        // with your usual mic and camera" over PreJoin's "Ready to join?" heading was a lie on
        // any slow join — and its 4s timer expired before the stage ever appeared, taking the
        // "Change devices" undo (the whole point of the skip path) with it.
        if (didAutoJoinRef.current) setPill('Joined with your usual mic and camera.');
      })
      .catch(() => {
        // ⚠ NO `log.error` — `@/lib/logging` is bare pino + AsyncLocalStorage and is NOT
        // client-safe. The failure is observed by the analytics event below, which carries a
        // CODE and never the token, the room url or the vendor's message.
        setHasFailed(true);
        track(MEETING_CALL_EVENTS.ERROR, { ...meetingProps, code: 'join_failed' });
      })
      .finally(() => setIsJoining(false));
  }, [daily, grant, isJoining, meetingProps]);

  /**
   * ⚠⚠ THE SKIP PATH — ONE-SHOT, FOR THE LIFE OF THE FRAME.
   *
   * `didAutoJoinRef` is what makes it one: `hasJoined` is a dependency, and it flips back to
   * `false` on eject and on leave, so without the ref this effect re-fired on exactly those
   * transitions and rejoined an ejected participant with no interaction at all. `exitReason` is
   * the second guard, and either alone would close the hole — both are here because they fail
   * closed in different ways.
   */
  useEffect(() => {
    if (daily === null || hasJoined || isJoining || hasFailed) return;
    if (exitReason !== null || didAutoJoinRef.current) return;
    if (!readSkipPrejoin()) return;
    didAutoJoinRef.current = true;
    join();
  }, [daily, hasJoined, hasFailed, isJoining, exitReason, join]);

  useEffect(() => {
    if (pill === null) return;
    const timer = setTimeout(() => setPill(null), SKIP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [pill]);

  /**
   * ⚠⚠ THE LATCH ITSELF. Everything that ends this frame goes through here exactly once: the
   * analytics event, the terminal state, and the route's own navigation (which both GUEST mounts
   * structurally do not have — which is precisely why the terminal card exists).
   */
  const finishExit = useCallback(
    (reason: MeetingExitReason): void => {
      if (hasExitedRef.current) return;
      hasExitedRef.current = true;
      const startedAt = callStartedAtRef.current;
      track(MEETING_CALL_EVENTS.LEFT, {
        ...meetingProps,
        reason,
        duration_ms: startedAt === null ? 0 : Date.now() - startedAt,
      });
      setHasJoined(false);
      setExitReason(reason);
      // ⚠ THE DESTINATION IS ROUTE-SCOPED. A guest has none, so the frame renders the terminal
      // notice instead — never PreJoin, and never a rejoin affordance. BAL-389 takes this seam
      // over unchanged.
      route.onExit?.(reason);
    },
    [meetingProps, route]
  );

  const exit = useCallback(
    (reason: MeetingExitReason): void => {
      if (hasExitedRef.current) return;
      leaveRequestedRef.current = true;
      daily?.leave().catch(() => {});
      finishExit(reason);
    },
    [daily, finishExit]
  );

  /**
   * BAL-134 / ADR-1049 — ⚠⚠ **THE SERVER ENDS THE MEETING. THE LOCAL TEARDOWN IS COSMETIC.**
   *
   * BAL-435 shipped this as `daily.updateParticipants({ '*': { eject: true } })` and nothing
   * else, and **that ended nothing.** Per the `daily-co` skill's own trap list an eject does NOT
   * revoke a token, and Balo mints tokens with `eject_at_token_exp: false` and `exp` at
   * scheduled end + 24h — so every "ejected" participant could rejoin immediately, and the
   * meeting row stayed `in_progress` with its presence intervals open, measuring against the
   * wall clock. `POST /meetings/:meetingId/end` is what fixes it at the root: it closes the
   * intervals, writes `status='ended'` + `ended_at` + `ended_by` in ONE transaction, and DELETES
   * the Daily room so the vendor cannot admit anybody either.
   *
   * ⚠⚠ **THE SERVER CALL COMES FIRST, AND THE LOCAL TEARDOWN ONLY RUNS ON ITS SUCCESS.** Ejecting
   * optimistically would feel a few hundred milliseconds faster and would be dishonest: a refused
   * or dropped end would have thrown everybody out of a call that is still running, on a surface
   * where the only recovery is to re-join a room the server never closed. `isEnding` covers the
   * whole round trip, which is exactly what makes the confirm's "Ending…" a reachable state.
   *
   * ⚠ `alreadyEnded` IS A **SUCCESS** (D10) — two holders can press End in the same instant and
   * the loser's `200` is the correct answer, not a red toast on the one control that must work.
   *
   * ⚠ **NO SUCCESS TOAST, DELIBERATELY.** The success feedback is the whole screen changing:
   * `finishExit` latches terminal and the member route replaces itself with BAL-389's
   * end-of-call screen. A toast announcing what the page already says is noise on top of a
   * navigation. The FAILURE arm is the one that needs a voice, because nothing else changes.
   *
   * ⚠ `route.endMeeting === null` MEANS **NO END ACTION IS WIRED** — structurally true on both
   * GUEST mounts (which is belt-and-braces there, since the server hard-codes their
   * `canEndMeeting` to `false`), and a WIRING BUG anywhere else. Falling back to the local eject
   * would re-create the exact defect this ticket removes, so it says the call is still running.
   */
  const endMeetingAction = route.endMeeting;
  const endForEveryone = useCallback((): void => {
    /*
      ⚠⚠ THIS ARM USED TO `return` SILENTLY — with the confirm dialog still open and its button
      still live, so pressing End did visibly nothing, forever, while the sibling arm two lines
      below toasted. All three of these are the same class of failure from the person's side ("I
      asked to end the call and it is still running"), so all three say the same thing.

      ⚠ `daily === null` is the call object not being ready; `!grant.canEndMeeting` is a control
      that should not have rendered at all (`LeaveControl` omits it from the DOM for non-holders)
      and is therefore a wiring bug; `endMeetingAction === null` is the guest/unwired mount. None
      of them is recoverable here, and none of them may fall back to a local eject — that revokes
      no token and is the exact defect this ticket removes.
    */
    if (daily === null || !grant.canEndMeeting || endMeetingAction === null) {
      toast.error(END_MEETING_FAILED_COPY);
      return;
    }
    setIsEnding(true);
    track(MEETING_CALL_EVENTS.ENDED_FOR_ALL, {
      ...meetingProps,
      participant_count: participantIds.length,
    });
    endMeetingAction()
      .then((result) => {
        if (!result.success) {
          toast.error(result.error);
          setIsEnding(false);
          return;
        }
        // ── The meeting is genuinely over. Everything below is IMMEDIACY, not authority. ──
        //
        // ⚠ `updateParticipants` IS SYNCHRONOUS in daily-js (it returns the call object, not a
        // promise) — do not `await` it or chain a `.catch`, both of which would be type errors.
        // It exists so the other participants' screens change now rather than whenever their
        // own poll notices; the room is already deleted server-side.
        daily.updateParticipants({ '*': { eject: true } });
        leaveRequestedRef.current = true;
        // ⚠ THE FRAME LATCHES TERMINAL HERE, which unmounts the toolbar and the confirm with it.
        daily
          .leave()
          .catch(() => {})
          .finally(() => finishExit('host_ended'));
      })
      .catch(() => {
        // ⚠ THE TRANSPORT ARM. The Server Action itself threw, so no server answered — and the
        // one thing we must not do is act as though it had.
        toast.error(END_MEETING_FAILED_COPY);
        setIsEnding(false);
      });
  }, [
    daily,
    endMeetingAction,
    finishExit,
    grant.canEndMeeting,
    meetingProps,
    participantIds.length,
  ]);

  /**
   * ⚠⚠ EJECTED, OR THE ROOM WENT AWAY — **AND IT IS DISTINGUISHED FROM OUR OWN LEAVE BY A REF**,
   * because Daily's `left-meeting` payload says nothing about who caused it. If we did not ask,
   * somebody else did: latch terminal with `host_ended` so the member route navigates out and a
   * guest gets a card with no way back in.
   */
  useDailyEvent(
    'left-meeting',
    useCallback((): void => {
      setHasJoined(false);
      if (leaveRequestedRef.current) return;
      finishExit('host_ended');
    }, [finishExit])
  );

  /** ⚠ A DENIED SHARE IS NOT A CANCELLED ONE — see `SCREENSHARE_BLOCKED_PILL`. */
  useDailyEvent(
    'nonfatal-error',
    useCallback((event: { type?: string }): void => {
      if (event.type !== 'screen-share-error') return;
      setPill(SCREENSHARE_BLOCKED_PILL);
    }, [])
  );

  const toggleScreenShare = useCallback((): void => {
    if (isSharingScreen) {
      stopScreenShare();
      return;
    }
    // ⚠ A CANCELLED PICKER IS SILENT. Cancelling a picker is not an error — and the analytics
    // events fire on the OBSERVED transition below, never here, so a cancel is not counted as a
    // start.
    startScreenShare();
  }, [isSharingScreen, startScreenShare, stopScreenShare]);

  /**
   * ⚠ THE SHARE EVENTS FIRE ON THE **TRANSITION**, not on the click. Tracking `started` at click
   * time counted every cancelled picker as a share, which is the one number this event exists to
   * be right about.
   */
  const wasSharingRef = useRef(false);
  useEffect(() => {
    if (isSharingScreen && !wasSharingRef.current) {
      wasSharingRef.current = true;
      shareStartedAtRef.current = Date.now();
      track(MEETING_CALL_EVENTS.SCREENSHARE_STARTED, { ...meetingProps });
      return;
    }
    if (!isSharingScreen && wasSharingRef.current) {
      wasSharingRef.current = false;
      const startedAt = shareStartedAtRef.current;
      track(MEETING_CALL_EVENTS.SCREENSHARE_STOPPED, {
        ...meetingProps,
        duration_ms: startedAt === null ? 0 : Date.now() - startedAt,
      });
      shareStartedAtRef.current = null;
    }
  }, [isSharingScreen, meetingProps]);

  const screenSessionIds = useMemo(
    () => new Set(screens.map((screen) => screen.session_id)),
    [screens]
  );

  const candidates = useMemo<TileCandidate[]>(
    () =>
      participantIds.map((sessionId, index) => ({
        sessionId,
        isLocal: sessionId === localSessionId,
        isScreenSharing: screenSessionIds.has(sessionId),
        // ⚠ THE LIST IS ALREADY `joined_at`-SORTED BY DAILY, so the index IS the join order. It
        // is NEVER used as a React key.
        joinedAtMs: index,
      })),
    [participantIds, localSessionId, screenSessionIds]
  );

  const remoteCount = candidates.filter((candidate) => !candidate.isLocal).length;
  const kind = resolveStageKind({
    hasJoined,
    remoteCount,
    isAnyoneScreenSharing: screens.length > 0,
    override,
  });

  const tiles = useMemo(
    () => orderTiles(candidates, activeSpeakerId),
    [candidates, activeSpeakerId]
  );

  const toggleLayout = useCallback((): void => {
    setOverride((current) => {
      const next: LayoutOverride = current === 'gallery' ? 'spotlight' : 'gallery';
      track(MEETING_CALL_EVENTS.LAYOUT_CHANGED, {
        ...meetingProps,
        from: current ?? 'spotlight',
        to: next,
        source: 'manual',
      });
      return next;
    });
  }, [meetingProps]);

  /** §7.2 — the spotlight PIP is MOVEABLE: tap swaps which of the two fills the stage. */
  const swapSelf = useCallback((): void => {
    setSelfIsPrimary((current) => !current);
  }, []);

  useWakeLock(hasJoined);
  const { message: announcement, announce } = useCallAnnouncement({
    hasJoined,
    isReconnecting,
    remoteCount,
    micOn,
  });

  const joinedTrackedRef = useRef(false);
  useEffect(() => {
    if (!hasJoined || joinedTrackedRef.current) return;
    joinedTrackedRef.current = true;
    const startedAt = joinStartedAtRef.current;
    track(MEETING_CALL_EVENTS.JOINED, {
      ...meetingProps,
      // ⚠ THE SERVER'S VERDICT, PASSED THROUGH. A verdict, not a secret.
      is_owner: grant.isOwner,
      layout: kind,
      // ⚠ THE DECISION, FROM THE REF THAT RECORDED IT. Reading the PILL reported `false` on every
      // join slower than the pill's own 4s life — i.e. on exactly the slow joins this metric
      // exists to measure.
      prejoin_skipped: didAutoJoinRef.current,
      ms_to_joined: startedAt === null ? 0 : Date.now() - startedAt,
      // ⚠ THE LIVE TILE COUNT, never the roster seat count.
      participant_count_at_join: participantIds.length,
    });
  }, [hasJoined, grant.isOwner, kind, meetingProps, participantIds.length]);

  /**
   * BAL-436 — ⚠⚠ **IDENTITY-STABLE SEAT UPDATES.** The poll hands us a FRESH OBJECT LITERAL on
   * every tick, so a bare `setSeats` re-rendered `MeetingFrameInner` — and therefore the WHOLE
   * in-call subtree, video stage included — every 10 seconds for the life of an open panel,
   * with identical numbers. `Object.is` can never save a caller who allocates.
   *
   * ⚠ THE COMPARISON LIVES **HERE**, IN THE SETTER, NOT IN THE POLL. The poll cannot know
   * whether its consumer cares about identity, and a comparator passed down would be one more
   * thing to forget at a second call site. Returning `prev` from the updater is React's own
   * bail-out, so an unchanged tick costs one function call and no render.
   */
  const onSeatsChange = useCallback((next: MeetingRoster): void => {
    setSeats((current) =>
      current !== null &&
      current.participantCount === next.participantCount &&
      current.participantCap === next.participantCap
        ? current
        : next
    );
  }, []);

  useSeatCountOnJoin({ panels: route.panels, hasJoined, onSeats: onSeatsChange });

  const { isFatal, showChrome, topBarHeadingRef } = resolveFrameChrome({
    hasFailed,
    meetingState,
    exitReason,
    kind,
    headingRef,
  });
  // ⚠ FROM THE ROUTE CONTEXT — the SAME table `backTo` comes from, so the confirm dialog and the
  // back link cannot disagree. `'call'` on both guest mounts, structurally.
  const contextNoun = route.contextNoun;
  const presenter = screens.at(0);

  /**
   * BAL-436 — ⚠⚠ **REGISTERED MEANS OPENABLE.** `panels === null` (both GUEST mounts,
   * structurally) means no toolbar buttons, no More-sheet rows, no seat chip, no interactive
   * overflow tile and no panel. Not disabled — ABSENT.
   */
  const panels = route.panels;
  const {
    panel,
    // ⚠ RAW — the WRAPPED version (from `useDrawdownBalanceSlot`, below) is what every manual
    // caller downstream actually uses. See that hook's W5 docblock for why the wrap exists.
    togglePanel: rawTogglePanel,
    openPanel,
    closePanel,
    peopleButtonRef,
    filesButtonRef,
    chatButtonRef,
    balanceButtonRef,
  } = useMeetingPanel({
    isRegistered: panels !== null,
    isTerminal: exitReason !== null || isFatal,
  });

  /**
   * BAL-437 — ⚠ THE **MORE** TRIGGER, HELD HERE BECAUSE TWO SIBLINGS NEED IT: `MeetingToolbar`
   * renders it (through `MoreSheet`) and `ReactionPicker` focuses it when the mobile picker
   * closes. The frame is their nearest common ancestor. See `useCallRealtimeSlot`'s prop doc.
   */
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  const { realtime, reactionControl, onOpenReactions } = useCallRealtimeSlot({
    panels,
    panel,
    isTerminal: exitReason !== null || isFatal,
    meetingProps,
    announce,
    moreButtonRef,
  });

  /**
   * BAL-403 — the drawdown poll (runs while REGISTERED, above `FramePanel`, NOT gated on the
   * panel being open — see `use-drawdown-poll.ts`'s divergence note) plus the auto-open ladder.
   *
   * ⚠ fix round 1 (W5) — RETURNS THE **WRAPPED** `togglePanel`, which every manual caller below
   * (the toolbar, the More sheet, People/Files/Chat) now uses instead of the raw one, so any
   * click clears `autoOpened` before `panel` itself changes.
   */
  const {
    drawdown,
    attention: balanceAttention,
    autoOpened: balanceAutoOpened,
    togglePanel,
  } = useDrawdownBalanceSlot({
    panels,
    panel,
    isTerminal: exitReason !== null || isFatal,
    openPanel,
    closePanel,
    togglePanel: rawTogglePanel,
    announce,
  });

  const { openPeopleSlot, toolbarPanelSlot, roster } = resolvePanelSlots({
    panels,
    panel,
    seats,
    togglePanel,
    peopleButtonRef,
    filesButtonRef,
    chatButtonRef,
    unreadChat: realtime.unreadChat,
    reactionControl,
    onOpenReactions,
    balanceButtonRef,
    balanceAttention,
  });

  return (
    <MeetingFrameElementProvider element={frameElement}>
      <motion.div
        ref={setFrameElement}
        // ⚠⚠ `className="dark"` MAKES THE WHOLE SUBTREE DARK VIA `globals.css`'s `.dark { … }`
        // VARIABLE BLOCK — with zero hex anywhere. ⚠ DO NOT WRITE A `dark:`-PREFIXED UTILITY ON
        // THIS ELEMENT: the variant is `&:is(.dark *)`, a DESCENDANT selector, so a `dark:` class
        // on the element that carries `.dark` silently does nothing. Descendants are fine.
        className="dark bg-background text-foreground relative flex h-full min-h-0 w-full flex-col overflow-hidden lg:rounded-[20px]"
        // §13.1 step 1 — the frame fades in. Every other step delays off this one.
        {...entrance(reduceMotion, {}, 0)}
      >
        {/*
          ⚠⚠ §16 — THE ONE POLITE LIVE REGION. Never wrapped in anything `aria-busy`.

          ⚠⚠ BAL-436 — THE SIDE PANEL ANNOUNCES **THROUGH THIS ONE**, via `announce` on the
          registration below. There is deliberately NO second `aria-live` region in the panel:
          two regions on one surface race, and a screen reader queues both so the person hears
          the older sentence after the newer one.
        */}
        <MeetingAnnouncer message={announcement} />

        {showChrome ? (
          <motion.div {...entrance(reduceMotion, { y: -8 }, 0.06)}>
            <MeetingTopBar
              headingRef={topBarHeadingRef}
              // ⚠⚠ THE WAITING STAGE OWNS THE `<h1>` IN ITS OWN STATE. Withholding the ref alone
              // left the bar emitting a SECOND `<h1>` — two competing answers to "what is this
              // screen". Exactly one per state, always.
              isPrimaryHeading={kind !== 'waiting'}
              /*
                BAL-134 (§7.3) — ⚠⚠ **THE SERVER MIRROR, WITH BAL-435's CHROME AS THE FALLBACK.**

                `route.clock` is produced by the pure `resolveTopBarClock` from the POLLED state,
                so the EXPERT sees `{elapsed} counted` in amber while they wait — their clock
                genuinely is running from `max(scheduled_start, their join)` — and the CLIENT
                correctly keeps `Not started` in the same room state, because nothing is being
                charged until both parties are present. Two different true sentences about one
                meeting; BAL-435 could only say `● Live` to both, which is why an expert reads
                "not started" at minute eight and leaves before a settlement they had earned.

                ⚠ `null` IS A LIVE PATH, NOT A GUARD: both GUEST mounts poll nothing (the state
                route is member-only) and the member route has no snapshot until the first poll
                lands. Both keep exactly the chrome BAL-435 shipped rather than flashing
                "Not started" over a live call.

                ⚠ NO CLIENT-SIDE THRESHOLD AND NO LOCAL DURATION MATH ANYWHERE HERE.
                `MeetingClockSlot` ticks its own display and drift-corrects against `asOf`.
              */
              clock={route.clock ?? (hasJoined ? { kind: 'live' } : { kind: 'not_started' })}
              network={networkState === 'bad' || networkState === 'warning' ? 'unstable' : 'strong'}
              // ⚠⚠ SEAT COUNT, NOT TILE COUNT. It comes from the guests GET — the very counter
              // the server refuses invites on — and it is `null` until the People panel has been
              // opened once, at which point the chip appears and then SURVIVES the panel closing.
              // An unavailable count is not a count: the whole chip stays absent rather than
              // rendering a lone numberless glyph.
              roster={roster}
              // ⚠ ITS PRESENCE PROMOTES THE CHIP TO A REAL BUTTON. Absent when unregistered.
              {...openPeopleSlot}
            />
          </motion.div>
        ) : null}

        {/*
          ⚠ THE PILLS FLOAT **OVER** THE STAGE RATHER THAN SITTING IN NORMAL FLOW. In flow they
          shrank the video area when a pill appeared and grew it again when it expired — two
          layout jumps in the first four seconds of a call, and two more if both pills stacked.
          `pointer-events-none` on the rail keeps the stage clickable; each pill re-enables its
          own so "Change devices" still works.
        */}
        {pill === null && deviceNotice === null ? null : (
          <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex flex-col items-center gap-2">
            {pill === null ? null : (
              <span className="pointer-events-auto">
                <MeetingPill
                  message={pill}
                  actionLabel="Change devices"
                  onAction={() => setSettingsOpen(true)}
                />
              </span>
            )}
            {deviceNotice === null ? null : (
              <span className="pointer-events-auto">
                <MeetingPill
                  message={deviceNotice}
                  tone="warning"
                  actionLabel="Show me how"
                  onAction={() => setSettingsOpen(true)}
                />
              </span>
            )}
          </div>
        )}

        <div className="relative flex min-h-0 flex-1">
          <motion.div
            className="min-w-0 flex-1 p-3"
            {...entrance(reduceMotion, { scale: 0.98 }, 0.1)}
          >
            <div className="from-card to-background/60 relative h-full w-full overflow-hidden rounded-2xl bg-gradient-to-b">
              <FrameStage
                kind={kind}
                isFatal={isFatal}
                exitReason={exitReason}
                contextNoun={contextNoun}
                tiles={tiles}
                activeSpeakerId={activeSpeakerId}
                screenSessionId={presenter?.session_id ?? null}
                headingRef={headingRef}
                displayName={route.viewerName}
                waiting={route.waiting}
                // ⚠ BAL-134 — the server's phase label. `'pre-start'` on both guest mounts.
                waitingPhase={route.waitingPhase}
                // ⚠ BAL-134 — the facts the copy may not assert without. All-unknown on both
                // guest mounts and before the first poll, so the copy claims less rather than
                // more. See `WaitingFacts`.
                waitingFacts={route.waitingFacts}
                isJoining={isJoining}
                micOn={micOn}
                cameraOn={cameraOn}
                selfIsPrimary={selfIsPrimary}
                onSwapSelf={swapSelf}
                // ⚠ BAL-436 — threaded to `OverflowTile`. Absent ⇒ the tile stays exactly as
                // it shipped: non-interactive, no hover affordance, no accessible name.
                {...openPeopleSlot}
                onToggleMic={toggleMic}
                onToggleCamera={toggleCamera}
                onOpenSettings={() => setSettingsOpen(true)}
                onJoin={join}
                onRetry={() => {
                  setHasFailed(false);
                  join();
                }}
              />
              {showChrome ? (
                <>
                  <ViewControls
                    frameElement={frameElement}
                    showLayoutToggle={isVideoLayout(kind)}
                    isGallery={kind === 'gallery'}
                    onToggleLayout={toggleLayout}
                  />
                  {/*
                    ⚠ BAL-437 — `pointer-events-none` + `aria-hidden`, both load-bearing. See
                    `reaction-floaters.tsx`: without the first, this layer eats every click on
                    the video for the 2.2s a reaction is in flight.

                    ⚠ IT SHARES `showChrome`'s BRANCH RATHER THAN ADDING ITS OWN — reactions
                    belong over the LIVE stage, never over PreJoin, the fatal card or the
                    terminal notice, which is exactly what `showChrome` already means. Folding
                    it in also keeps this component under SonarCloud's complexity ceiling.
                  */}
                  <ReactionFloaters floaters={realtime.floaters} />
                </>
              ) : null}
              {isReconnecting ? (
                <ReconnectingOverlay isLongWait={isLongReconnect} onLeave={() => exit('self')} />
              ) : null}
            </div>
          </motion.div>

          {/*
            ⚠⚠ BAL-436 — THE PANEL IS A **SIBLING OF THE STAGE INSIDE THIS FLEX ROW**, not an
            overlay on top of it. At `lg` and above it takes 360px beside the video; below `lg`
            its own classes make it a full-height overlay (`absolute inset-0`) — ⚠ OF THIS ROW
            ONLY, which is why the row is `relative`. `MeetingToolbar` renders OUTSIDE and BELOW
            this row, so Mic / Camera / More / Leave stay visible and reachable underneath the
            panel on a phone. That is exactly why the panel is NOT a modal and carries no focus
            trap (`meeting-side-panel.tsx` has the full argument). The split is CSS, so nothing
            flashes on first paint.

            ⚠ RENDERED ONLY WHEN THE SLOT IS REGISTERED **AND** OPEN. `panels === null` on both
            GUEST mounts, structurally — no lens check, no role check, nowhere.
          */}
          {/*
            ⚠ `AnimatePresence` SO CLOSING IS NOT A HARD CUT. The panel animates IN and, without
            this, vanished in one frame — which on a 360px sidebar reads as a glitch rather than
            as a dismissal. ⚠ NO `mode="wait"`: switching People→Files must cross-fade in place,
            and `wait` would blank the column for the length of the exit.
          */}
          <AnimatePresence initial={false}>
            <FramePanel
              key={panel ?? 'closed'}
              panels={panels}
              panel={panel}
              onClose={closePanel}
              onOpenFiles={() => togglePanel('files')}
              onSeatsChange={onSeatsChange}
              meetingProps={meetingProps}
              onAnnounce={announce}
              realtime={realtime}
              drawdown={drawdown}
              balanceAutoOpened={balanceAutoOpened}
            />
          </AnimatePresence>
        </div>

        {isSharingScreen ? <PresentingBar onStop={toggleScreenShare} /> : null}

        {showChrome ? (
          <motion.div {...entrance(reduceMotion, { y: 12 }, 0.18)}>
            <MeetingToolbar
              micOn={micOn}
              cameraOn={cameraOn}
              onToggleMic={toggleMic}
              onToggleCamera={toggleCamera}
              isSharingScreen={isSharingScreen}
              canShareScreen={canShareScreen}
              onToggleScreenShare={toggleScreenShare}
              showLayoutToggle={isVideoLayout(kind)}
              isGallery={kind === 'gallery'}
              onToggleLayout={toggleLayout}
              onOpenSettings={() => setSettingsOpen(true)}
              moreButtonRef={moreButtonRef}
              moreOpen={moreOpen}
              onMoreOpenChange={setMoreOpen}
              // ⚠ BOTH ABSENT WHEN THE SLOT IS UNREGISTERED — the toolbar renders no People or
              // Files control at all, rather than two disabled ones.
              {...toolbarPanelSlot}
              // ⚠⚠ THE SERVER'S END-AUTHORITY VERDICT (`isOwner || clientPrincipal`), UNMODIFIED.
              // Never a lens, and ⚠ NEVER `isOwner` — that one mints the Daily owner token and
              // would deny the paying client the ability to stop their own per-minute spend.
              canEndMeeting={grant.canEndMeeting}
              contextNoun={contextNoun}
              isCase={contextNoun === 'case'}
              onLeave={() => exit('self')}
              onEndForEveryone={endForEveryone}
              isEnding={isEnding}
            />
          </motion.div>
        ) : null}

        <DeviceSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      </motion.div>
    </MeetingFrameElementProvider>
  );
}

interface FrameStageProps {
  readonly kind: ReturnType<typeof resolveStageKind>;
  readonly isFatal: boolean;
  /** ⚠ Non-null ⇒ TERMINAL. See the module docblock; it outranks every other state but fatal. */
  readonly exitReason: MeetingExitReason | null;
  readonly contextNoun: string;
  readonly tiles: ReturnType<typeof orderTiles>;
  readonly activeSpeakerId: string | null;
  readonly screenSessionId: string | null;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
  readonly displayName: string | null;
  /** ⚠ `null` ⇒ party-neutral waiting copy (ruling R10). */
  readonly waiting: WaitingSubject | null;
  /**
   * BAL-134 (§7.3) — how far the wait has run.
   *
   * ⚠⚠ **A LABEL THE SERVER COMPUTED**, from the env-resolved timers. The browser never derives
   * `near` from a duration; see `meeting-state.ts`'s docblock for why that is structural.
   * `'pre-start'` on both GUEST mounts, structurally — they mount no route provider.
   */
  readonly waitingPhase: WaitingPhase;
  /**
   * BAL-134 — the server-mirror facts the waiting copy may not assert without: the no-show floor
   * in minutes, the settled outcome, and whether an expert has actually been OBSERVED in the
   * room. All-unknown on both GUEST mounts and before the first poll lands.
   */
  readonly waitingFacts: WaitingFacts;
  readonly isJoining: boolean;
  readonly micOn: boolean;
  readonly cameraOn: boolean;
  readonly selfIsPrimary: boolean;
  readonly onSwapSelf: () => void;
  readonly onToggleMic: () => void;
  readonly onToggleCamera: () => void;
  readonly onOpenSettings: () => void;
  readonly onJoin: () => void;
  readonly onRetry: () => void;
}

/**
 * ⚠ THE KIND→SURFACE SWITCH, EXTRACTED. Inlined in `MeetingFrameInner` it pushes that component
 * past SonarCloud's cognitive-complexity limit of 15 — the repo's own precedent is to EXTRACT,
 * not to disable (`JoinPhaseContent` was split out of `JoinControl` for exactly this).
 *
 * ⚠ THE ORDER OF THESE BRANCHES IS CONTRACT: fatal, then TERMINAL, then prejoin. A terminal frame
 * must never fall through to PreJoin's "Join now" — that is the whole of the latch.
 */
function FrameStage({
  kind,
  isFatal,
  exitReason,
  contextNoun,
  tiles,
  activeSpeakerId,
  screenSessionId,
  headingRef,
  displayName,
  waiting,
  waitingPhase,
  waitingFacts,
  isJoining,
  micOn,
  cameraOn,
  selfIsPrimary,
  onSwapSelf,
  onToggleMic,
  onToggleCamera,
  onOpenSettings,
  onJoin,
  onRetry,
}: Readonly<FrameStageProps>): React.JSX.Element {
  if (isFatal) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-6">
        <JoinRetryNotice headingRef={headingRef} onRetry={onRetry} />
        <BackToContextLink />
      </div>
    );
  }
  if (exitReason !== null) {
    return (
      <MeetingEndedNotice reason={exitReason} contextNoun={contextNoun} headingRef={headingRef} />
    );
  }
  if (kind === 'prejoin') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center">
        <PreJoin
          displayName={displayName}
          isJoining={isJoining}
          micOn={micOn}
          cameraOn={cameraOn}
          onToggleMic={onToggleMic}
          onToggleCamera={onToggleCamera}
          onOpenSettings={onOpenSettings}
          onJoin={onJoin}
          headingRef={headingRef}
        />
        {/*
          ⚠ THE FIRST SCREEN NEEDS AN EXIT TOO. PreJoin suppresses the top bar, the toolbar and the
          More menu, so until this link existed a member who opened the call and decided not to
          join had NO affordance on the page at all — browser back only. It is the same shared
          link, so it is still absent for a guest (who has no Balo destination), structurally.
        */}
        <BackToContextLink />
      </div>
    );
  }
  if (kind === 'waiting') {
    return (
      <WaitingStage
        // ⚠⚠ BAL-134 — THE PRODUCER BAL-435 LEFT A HOLE FOR. All four phases and both parties'
        // copy already shipped with the component; this is the line that makes the progression
        // reachable. The phase is the SERVER's answer, never a threshold computed here.
        phase={waitingPhase}
        // ⚠⚠ RULING R10 — THE REAL SUBJECT, OR `null` FOR PARTY-NEUTRAL COPY. It used to be
        // hard-coded `absentParty="expert"` with two placeholder literals, which showed the
        // delivering EXPERT the CLIENT's billing promise on a money surface.
        subject={waiting}
        facts={waitingFacts}
        headingRef={headingRef}
      />
    );
  }
  return (
    <StageContent
      kind={kind}
      tiles={tiles}
      activeSpeakerId={activeSpeakerId}
      screenSessionId={screenSessionId}
      selfIsPrimary={selfIsPrimary}
      onSwapSelf={onSwapSelf}
    />
  );
}

/**
 * BAL-436 — the SIDE-PANEL STATE MACHINE.
 *
 * ⚠⚠ **THE TOGGLE IS THE WHOLE RULING (BAL-132 D11).** Re-clicking the OPEN panel's button
 * CLOSES it; clicking the other button SWITCHES. There is no tab strip — the design reference
 * has none, and a strip would imply the two panels coexist.
 *
 * ⚠ FOCUS RETURNS TO THE BUTTON THAT OPENED IT, and it is done in the CLOSE HANDLER rather
 * than in an effect. The `useFocusOnTransition` policy exists because an effect reading
 * `ref.current` on a state change focuses an element that is about to unmount; restoring focus
 * in the handler that unmounts the panel has no such ordering problem, because the TOOLBAR
 * button is already mounted and stays mounted.
 *
 * ⚠⚠ A TERMINAL FRAME CLOSES THE PANEL. A frame that has ended must not keep a live roster on
 * screen — and closing it unmounts the poll, so nothing keeps asking the api about a call that
 * is over. It deliberately does NOT restore focus there: on a terminal frame the toolbar is
 * unmounted too, and the terminal card owns the heading and takes focus itself.
 *
 * ⚠ AN UNREGISTERED SLOT FORCES `null`. Both GUEST mounts land there structurally, so nothing
 * downstream needs a second "is it registered?" check.
 *
 * ⚠ A HOOK RATHER THAN INLINE STATE, ONLY TO SHED COGNITIVE COMPLEXITY: inline,
 * `MeetingFrameInner`'s own body scored 27 against SonarCloud's allowed 15. The repo's
 * precedent is to EXTRACT, never to disable the rule.
 */
function useMeetingPanel(input: { readonly isRegistered: boolean; readonly isTerminal: boolean }): {
  readonly panel: MeetingPanelId | null;
  readonly togglePanel: (id: MeetingPanelId) => void;
  /** BAL-403 — opens without toggling. Auto-open uses this; a user click always uses `togglePanel`. */
  readonly openPanel: (id: MeetingPanelId) => void;
  readonly closePanel: () => void;
  readonly peopleButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly filesButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly chatButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly balanceButtonRef: React.RefObject<HTMLButtonElement | null>;
} {
  const [panel, setPanel] = useState<MeetingPanelId | null>(null);
  const peopleButtonRef = useRef<HTMLButtonElement | null>(null);
  const filesButtonRef = useRef<HTMLButtonElement | null>(null);
  const chatButtonRef = useRef<HTMLButtonElement | null>(null);
  /** BAL-403 — the fourth opener. Adding it here is a type error until `openers` below agrees. */
  const balanceButtonRef = useRef<HTMLButtonElement | null>(null);

  /**
   * ⚠ A LOOKUP OBJECT, NOT A NESTED TERNARY (SonarCloud). Three slots is where a chained `?:`
   * stops being readable, and a fourth would make the choice for us anyway.
   *
   * ⚠⚠ IT CLOSES OVER THE FOUR REFS DIRECTLY — **NO `useRef` MIRROR, NO RENDER-PHASE WRITE.**
   * An earlier version rebuilt this object every render and assigned it into a second ref during
   * the render phase, to keep `focusOpener` stable. That was unnecessary and unsafe at once: the
   * four refs are already stable for the component's whole lifetime (`useRef` returns the same
   * object forever), so closing over them keeps `focusOpener` stable with an EMPTY dependency
   * list and nothing is written during render. React may render without committing (Strict
   * Mode, a discarded concurrent render), which is precisely why a ref write belongs in an
   * effect or nowhere. Here it is nowhere.
   *
   * ⚠⚠ THIS MAP IS `Record<MeetingPanelId, …>` — TOTAL OVER THE UNION. BAL-403 adding `'balance'`
   * to `MeetingPanelId` is a compile error here until `balance` joins this object; that is the
   * mechanical forcing function, and it is a feature.
   */
  const focusOpener = useCallback(
    (id: MeetingPanelId): void => {
      const openers: Record<MeetingPanelId, React.RefObject<HTMLButtonElement | null>> = {
        people: peopleButtonRef,
        files: filesButtonRef,
        chat: chatButtonRef,
        balance: balanceButtonRef,
      };
      openers[id].current?.focus();
      // ⚠ THE FOUR REF OBJECTS ARE THE ONLY DEPENDENCIES, AND THEY NEVER CHANGE IDENTITY — a
      // `useRef` result is the same object for the component's whole lifetime. So this callback is
      // stable in practice while still being honestly exhaustive.
    },
    [peopleButtonRef, filesButtonRef, chatButtonRef, balanceButtonRef]
  );

  const togglePanel = useCallback(
    (id: MeetingPanelId): void => {
      setPanel((current) => {
        if (current === id) {
          focusOpener(id);
          return null;
        }
        track(MEETING_PANEL_EVENTS.OPENED, { panel: id });
        return id;
      });
    },
    [focusOpener]
  );

  /**
   * BAL-403 — opens WITHOUT toggling; a re-call with the same id is a no-op rather than a
   * close. This is what the auto-open ladder calls; `togglePanel` keeps its close-on-re-click
   * semantics and stays the ONLY path a user click ever takes.
   */
  const openPanel = useCallback((id: MeetingPanelId): void => {
    setPanel((current) => {
      if (current === id) return current;
      // ⚠ THE SAME FUNNEL EVENT A MANUAL OPEN FIRES — auto-opens are not distinguished from
      // manual ones today (noted as a future property addition in the BAL-403 plan, not built).
      track(MEETING_PANEL_EVENTS.OPENED, { panel: id });
      return id;
    });
  }, []);

  const closePanel = useCallback((): void => {
    setPanel((current) => {
      if (current !== null) focusOpener(current);
      return null;
    });
  }, [focusOpener]);

  const { isTerminal } = input;
  useEffect(() => {
    if (!isTerminal) return;
    setPanel(null);
  }, [isTerminal]);

  return {
    // ⚠ AN UNREGISTERED SLOT IS ALWAYS CLOSED, whatever state happens to be held.
    panel: input.isRegistered ? panel : null,
    togglePanel,
    openPanel,
    closePanel,
    peopleButtonRef,
    filesButtonRef,
    chatButtonRef,
    balanceButtonRef,
  };
}

/**
 * ⚠ A THIN SWITCH, EXTRACTED for the same reason `FrameStage` is: adding logic here is what
 * pushes the frame back over the complexity limit. `null` renders nothing at all — the slot
 * rule, and the state a closed panel is in.
 */
function FramePanel({
  panels,
  panel,
  onClose,
  onOpenFiles,
  onSeatsChange,
  meetingProps,
  onAnnounce,
  realtime,
  drawdown,
  balanceAutoOpened,
}: Readonly<{
  /** ⚠ `null` ⇒ UNREGISTERED. Both GUEST mounts, structurally. Renders nothing. */
  panels: MeetingPanelRegistration | null;
  panel: MeetingPanelId | null;
  onClose: () => void;
  /** BAL-437 — the chat timeline's "View in Files" swaps the single slot. */
  onOpenFiles: () => void;
  onSeatsChange: (seats: MeetingRoster) => void;
  meetingProps: Readonly<{ meeting_id?: string }>;
  /**
   * ⚠⚠ §16'S **ONE** POLITE LIVE REGION, HANDED DOWN. The panel announces admit / deny /
   * invite / upload OUTCOMES and a new arrival in the queue through this, never through a
   * second `aria-live` node of its own — two regions on one surface race.
   */
  onAnnounce: (message: string) => void;
  /** BAL-437 — the frame's one Ably client's state, threaded into both realtime-aware panels. */
  realtime: MeetingCallRealtime;
  /** BAL-403 — the frame's one drawdown poll, threaded into the Balance panel body. */
  drawdown: DrawdownPollState;
  /** BAL-403 fix round 1 (W5) — `true` ⇒ the ladder opened Balance, not a click. */
  balanceAutoOpened: boolean;
}>): React.JSX.Element | null {
  if (panels === null) return null;
  if (panel === 'people') {
    return (
      <PeoplePanel
        panels={panels}
        onClose={onClose}
        onSeatsChange={onSeatsChange}
        meetingProps={meetingProps}
        onAnnounce={onAnnounce}
      />
    );
  }
  if (panel === 'files') {
    return (
      <FilesPanel
        panels={panels}
        onClose={onClose}
        meetingProps={meetingProps}
        onAnnounce={onAnnounce}
        // ⚠ BAL-437 — THE REAL INVALIDATION. Replaced BAL-436's `window.focus` listener.
        fileRevision={realtime.fileRevision}
      />
    );
  }
  // ⚠ `panels.chat === null` ⇒ NO CHAT AT ALL. The toolbar renders no button either, so this
  // branch is unreachable through the UI — it is still written, because a slot rule enforced
  // in only one of two places is a slot rule that will be broken in the other.
  if (panel === 'chat' && panels.chat !== null) {
    return (
      <ChatPanel
        chat={panels.chat}
        files={panels.files}
        onClose={onClose}
        onOpenFiles={onOpenFiles}
        realtimeStatus={realtime.status}
        chatFeed={realtime.chatFeed}
        fileFeed={realtime.fileFeed}
        meetingProps={meetingProps}
        onAnnounce={onAnnounce}
      />
    );
  }
  // ⚠ `panels.balance === null` ⇒ NO BALANCE SLOT AT ALL — `false` for every meeting today (see
  // `meeting-panels.ts`). The toolbar renders no button either, so this branch is unreachable
  // through the UI while inert; it is still written for the same reason the Chat branch above
  // is: a slot rule enforced in only one of two places is a slot rule that will be broken in the
  // other.
  if (panel === 'balance' && panels.balance !== null) {
    return (
      <InCallBalancePanel
        state={drawdown.state}
        sessionId={drawdown.sessionId}
        status={drawdown.status}
        onClose={onClose}
        onRetry={drawdown.retry}
        autoOpened={balanceAutoOpened}
      />
    );
  }
  return null;
}
