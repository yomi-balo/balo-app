'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
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
import { TooltipProvider } from '@/components/ui/tooltip';
import { MEETING_CALL_EVENTS, track } from '@/lib/analytics';
import { orderTiles, type TileCandidate } from '@/lib/meetings/order-tiles';
import { isVideoLayout, resolveStageKind, type LayoutOverride } from '@/lib/meetings/resolve-stage';
import { useMeetingRoute, type MeetingExitReason } from '@/lib/meetings/meeting-route-context';
import type { WaitingSubject } from '@/lib/meetings/waiting-copy';
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
import { MeetingTopBar } from './meeting-top-bar';
import { PreJoin, readSkipPrejoin } from './prejoin';
import { StageContent } from './meeting-stage';
import { ViewControls } from './view-controls';
import { WaitingStage } from './waiting-stage';

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
 * That undid "End for everyone" (a client-side eject revokes no token — `ban:true` is BAL-436's)
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
 */
const NO_MEETING_PROPS: Readonly<Record<string, string>> = Object.freeze({});

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
function useDeviceBlockedNotice(meetingProps: Readonly<Record<string, string>>): string | null {
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
 */
function useCallAnnouncement(input: {
  readonly hasJoined: boolean;
  readonly isReconnecting: boolean;
  readonly remoteCount: number;
  readonly micOn: boolean;
}): string {
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

  return message;
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
  const meetingProps = useMemo((): Readonly<Record<string, string>> => {
    const id = route.meetingId;
    // ⚠ THE SHARED FROZEN EMPTY OBJECT, not a fresh `{}` — an inline literal would give the memo
    // a new identity on every recompute AND infer a `{ meeting_id?: undefined }` union that
    // `exactOptionalPropertyTypes` rejects against the index signature.
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

  const endForEveryone = useCallback((): void => {
    if (daily === null || !grant.isOwner) return;
    setIsEnding(true);
    track(MEETING_CALL_EVENTS.ENDED_FOR_ALL, {
      ...meetingProps,
      participant_count: participantIds.length,
    });
    // ⚠ THE OWNER TOKEN IS WHAT MAKES THIS LEGAL AT DAILY'S END. ⚠ Eject alone does NOT revoke a
    // token — a disconnected participant holding a live one can rejoin. `ban:true` /
    // `DELETE /rooms/:name` is a REST call and belongs to BAL-436, which is exactly why the
    // confirm copy does not claim this cannot be undone (ruling R7).
    // ⚠ `updateParticipants` IS SYNCHRONOUS in daily-js (it returns the call object, not a
    // promise) — do not `await` it or chain a `.catch`, both of which would be type errors.
    daily.updateParticipants({ '*': { eject: true } });
    leaveRequestedRef.current = true;
    // ⚠ THE LEAVE IS WHAT `isEnding` COVERS, AND IT IS GENUINELY ASYNCHRONOUS — so the confirm's
    // "Ending…" is a REACHABLE state rather than a label nothing can ever display. The frame then
    // latches terminal, which unmounts the toolbar and the dialog with it.
    daily
      .leave()
      .catch(() => {})
      .finally(() => finishExit('host_ended'));
  }, [daily, finishExit, grant.isOwner, meetingProps, participantIds.length]);

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
  const announcement = useCallAnnouncement({ hasJoined, isReconnecting, remoteCount, micOn });

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
        {/* ⚠⚠ §16 — THE ONE POLITE LIVE REGION. Never wrapped in anything `aria-busy`. */}
        <MeetingAnnouncer message={announcement} />

        {showChrome ? (
          <motion.div {...entrance(reduceMotion, { y: -8 }, 0.06)}>
            <MeetingTopBar
              headingRef={topBarHeadingRef}
              // ⚠⚠ THE WAITING STAGE OWNS THE `<h1>` IN ITS OWN STATE. Withholding the ref alone
              // left the bar emitting a SECOND `<h1>` — two competing answers to "what is this
              // screen". Exactly one per state, always.
              isPrimaryHeading={kind !== 'waiting'}
              // ⚠ RULING R4 — `● Live` while joined, `Not started` otherwise. NO DURATION, and no
              // client-side interval timer anywhere in this ticket.
              clock={hasJoined ? { kind: 'live' } : { kind: 'not_started' }}
              network={networkState === 'bad' || networkState === 'warning' ? 'unstable' : 'strong'}
              // ⚠ SEAT COUNT, NOT TILE COUNT — and the guests endpoint that produces it belongs to
              // BAL-436's People panel. Until then the whole chip is ABSENT: a lone `Users` glyph
              // with no number and nothing to click reads as a control that broke.
              roster={null}
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

        <div className="flex min-h-0 flex-1">
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
                isJoining={isJoining}
                micOn={micOn}
                cameraOn={cameraOn}
                selfIsPrimary={selfIsPrimary}
                onSwapSelf={swapSelf}
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
                <ViewControls
                  frameElement={frameElement}
                  showLayoutToggle={isVideoLayout(kind)}
                  isGallery={kind === 'gallery'}
                  onToggleLayout={toggleLayout}
                />
              ) : null}
              {isReconnecting ? (
                <ReconnectingOverlay isLongWait={isLongReconnect} onLeave={() => exit('self')} />
              ) : null}
            </div>
          </motion.div>
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
              moreOpen={moreOpen}
              onMoreOpenChange={setMoreOpen}
              // ⚠⚠ THE SERVER'S `host_meetings` VERDICT, UNMODIFIED. Never a lens.
              isOwner={grant.isOwner}
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
        // ⚠ ONLY `pre-start` IS PRODUCED TODAY. BAL-134 owns the transitions; the component and
        // its copy already ship all four phases so that wiring is a one-line change there.
        phase="pre-start"
        // ⚠⚠ RULING R10 — THE REAL SUBJECT, OR `null` FOR PARTY-NEUTRAL COPY. It used to be
        // hard-coded `absentParty="expert"` with two placeholder literals, which showed the
        // delivering EXPERT the CLIENT's billing promise on a money surface.
        subject={waiting}
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
