'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MeetingCallSurface } from '@/components/balo/meetings/meeting-call-surface';
import { preloadMeetingFrame } from '@/components/balo/meetings/meeting-frame';
import {
  JoinRetryNotice,
  JoinUnavailableNotice,
} from '@/components/balo/meetings/join-notice-card';
import { MeetingConnectingCard } from '@/components/balo/meetings/meeting-connecting-card';
import { useFocusOnTransition } from '@/lib/meetings/use-focus-on-transition';
import { MeetingRouteContextProvider } from '@/lib/meetings/meeting-route-context';
import {
  DASHBOARD_BACK_TO,
  resolveBackTo,
  resolveContextNoun,
} from '@/lib/meetings/back-to-context';
import {
  MEMBER_JOIN_EXHAUSTED_LINE,
  memberJoinRetryDelayMs,
} from '@/lib/meetings/member-join-retry';
import { parseMemberJoinEnvelope } from '@/lib/meetings/member-join-envelope';
import { formatScheduledStartLabel } from '@/lib/meetings/format-scheduled-start';
import { resolveWaitingSubject } from '@/lib/meetings/waiting-subject';
import { MEMBER_JOIN_OUTAGE_ERROR } from '@/lib/meetings/lobby';
import { useMeetingStatePoll } from '@/lib/meetings/use-meeting-state-poll';
import { resolveTopBarClock } from '@/lib/meetings/top-bar-clock';
import { joinAsMemberAction } from '@/app/join/_actions/join-as-member';
import { UNKNOWN_WAITING_FACTS, type WaitingFacts } from '@/lib/meetings/waiting-copy';
import {
  MEETING_STATE_RETRY_LABEL,
  MEETING_STATE_STALLED_COPY,
  type EndMeetingResult,
} from '@/lib/meetings/meeting-state';
import type { MemberJoinResponse } from '@/lib/meetings/join-api-client';
import type { MeetingPanelRegistration } from '@/lib/meetings/meeting-panels';
import { meetingChannelName } from '@/lib/realtime/channels';
import { getMeetingStateAction } from '../_actions/get-meeting-state';
import { endMeetingAction } from '../_actions/end-meeting';
import { getMeetingGuestsAction } from '../_actions/get-meeting-guests';
import { inviteMeetingGuestsAction } from '../_actions/invite-meeting-guests';
import { decideGuestAdmissionAction } from '../_actions/decide-guest-admission';
import { resendGuestLinkAction } from '../_actions/resend-guest-link';
import { createMeetingRealtimeTokenAction } from '../_actions/create-meeting-realtime-token';
import { fetchMeetingThreadAction } from '../_actions/fetch-meeting-thread';
import { postMeetingMessageAction } from '../_actions/post-meeting-message';
import { sendMeetingReactionAction } from '../_actions/send-meeting-reaction';
import { listMeetingFilesAction } from '@/app/(dashboard)/meetings/[meetingId]/_actions/list-meeting-files';
import { requestMeetingFileUploadAction } from '@/app/(dashboard)/meetings/[meetingId]/_actions/request-meeting-file-upload';
import { confirmMeetingFileUploadAction } from '@/app/(dashboard)/meetings/[meetingId]/_actions/confirm-meeting-file-upload';
import { getMeetingFileDownloadAction } from '@/app/(dashboard)/meetings/[meetingId]/_actions/get-meeting-file-download';

/**
 * BAL-435 — the THIRD mount of `MeetingCallSurface`, and the first production caller of
 * `joinAsMemberAction` (which BAL-132 shipped as a seam with no caller, naming this ticket).
 *
 * ⚠⚠ THE VENDOR CHUNK FETCH STARTS **IN PARALLEL WITH THE GRANT FETCH**, NOT AFTER IT. The AC is
 * "join-to-talking under three seconds for logged-in users" and the chunk is the long pole, so
 * both are kicked off in the same effect. `preloadMeetingFrame` uses the SAME module specifier as
 * the `dynamic()` inside `MeetingFrame`, so the bundler dedupes them to one chunk.
 *
 * ⚠ THE RETRY CADENCE IS THE **SHIPPED** ONE. A `503` means the meeting is not provisioned yet
 * (`join_url` is null), which is a real `201` outcome of `POST /meetings` when Daily was down.
 * `member-join-retry.ts` composes `pollIntervalFor` and `LOBBY_MAX_CONSECUTIVE_POLL_FAILURES`
 * rather than writing a second schedule.
 *
 * ⚠ NOTHING HERE TOUCHES THE TOKEN. The grant goes straight into `MeetingCallSurface`'s props;
 * it is never stored, logged or put in a URL.
 */

type Phase = 'connecting' | 'joined' | 'retrying' | 'unavailable';

export interface CallClientProps {
  readonly meetingId: string;
  /** ⚠ Resolved SERVER-SIDE from the session. `null` ⇒ PreJoin omits its identity line. */
  readonly viewerName: string | null;
  /**
   * BAL-436 — the BARE, TOKENLESS join URL for this meeting, built SERVER-SIDE from `APP_URL`.
   *
   * ⚠⚠ IT IS BUILT ON THE SERVER AND HANDED DOWN, NOT ASSEMBLED HERE FROM
   * `globalThis.location`. A client-assembled origin is whatever host the page happens to be
   * served from — a preview deployment, a proxy, a locally-mapped hostname — and a host would
   * copy that into a colleague's inbox believing it was the product's own link.
   *
   * ⚠ IT CARRIES NO TOKEN. The raw guest token never comes back from the api and this UI never
   * builds a link; whoever opens this lands in the pending lobby and must be admitted.
   */
  readonly joinLinkUrl: string;
  /**
   * BAL-437 — ⚠⚠ **RESOLVED SERVER-SIDE, ONCE.** `false` ⇒ this meeting has NO conversation
   * anchor (an `admin` call, a `project_discovery`, two ambiguous holder contexts, or a thread
   * that was never provisioned) ⇒ the Chat slot is ABSENT: no toolbar button, no More-sheet
   * row, no panel.
   *
   * ⚠ IT IS RESOLVED IN THE RSC RATHER THAN BY A FIRST CLIENT FETCH SO THERE IS NO **FLASH** —
   * a Chat button that appears on mount and vanishes when the first answer arrives is worse
   * than one that was never there.
   */
  readonly hasChat: boolean;
  /**
   * BAL-437 — ⚠ `false` ⇒ NO `ABLY_API_KEY` ⇒ the Reactions control is ABSENT (a reaction with
   * no transport reaches nobody) while CHAT STAYS REGISTERED, because chat has a durable record
   * and works entirely over HTTP. It degrades visibly with one line in the panel instead.
   */
  readonly isRealtimeEnabled: boolean;
  /**
   * BAL-437 — `conversation:{conversationId}`, built SERVER-SIDE from the gate's own resolution,
   * or `null` when there is no anchor.
   *
   * ⚠ IT IS NOT ASSEMBLED HERE FROM A CONVERSATION ID PASSED DOWN, because the conversation id
   * has no other use on this surface and shipping one to the browser that nothing renders is a
   * gratuitous identifier. The CHANNEL NAME is the only thing the client needs.
   */
  readonly chatChannelName: string | null;
}

export function CallClient({
  meetingId,
  viewerName,
  joinLinkUrl,
  hasChat,
  isRealtimeEnabled,
  chatChannelName,
}: Readonly<CallClientProps>): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [response, setResponse] = useState<MemberJoinResponse | null>(null);
  const [isExhausted, setIsExhausted] = useState(false);
  const failureCountRef = useRef(0);
  const startedAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * ⚠ THE RETRY RE-ENTERS THROUGH A REF, NOT THROUGH THE CALLBACK'S OWN IDENTITY. A `setTimeout`
   * closing over `attempt` would either need `attempt` in its own dependency list (a cycle) or
   * capture a stale one; the ref is the shipped `useAdmissionPoll` pattern for the same reason.
   */
  const attemptRef = useRef<() => void>(() => {});

  /**
   * ⚠ FOCUS FOLLOWS THE PHASE, via the same callback-ref policy both join surfaces use — an
   * effect reading `ref.current` on a state change focuses the element that is about to unmount.
   */
  const headingRef = useFocusOnTransition(phase);

  const attempt = useCallback((): void => {
    // ⚠ DELIBERATELY NOT AWAITED and NOT `void`-PREFIXED: this repo does not enable type-aware
    // linting so `no-floating-promises` never fires, and SonarCloud S3735 flags the operator —
    // the position `lobby-client.tsx` and `use-admission-poll.ts` already state by name.
    joinAsMemberAction({ meetingId })
      .then((result) => {
        if (result.success) {
          setResponse(result.grant);
          setPhase('joined');
          return;
        }
        // ⚠ THE **OUTAGE** COPY IS THE ONLY ONE THE ACTION DISTINGUISHES — the api collapses "no
        // such meeting", "not your party" and "no capability" into ONE literal, so this layer
        // cannot and must not try to say more.
        const isOutage = result.error === MEMBER_JOIN_OUTAGE_ERROR;
        if (!isOutage) {
          setPhase('unavailable');
          return;
        }
        failureCountRef.current += 1;
        setPhase('retrying');
        const delay = memberJoinRetryDelayMs(
          failureCountRef.current,
          Date.now() - startedAtRef.current
        );
        if (delay === null) {
          // ⚠ THE CARD STAYS AND ITS "Try again" BUTTON STAYS LIVE — giving up on the SCHEDULE is
          // not giving up on the person.
          setIsExhausted(true);
          return;
        }
        timerRef.current = setTimeout(() => attemptRef.current(), delay);
      })
      .catch(() => {
        // ⚠ THE TRANSPORT ARM. The Server Action itself threw, so no server answered and we
        // genuinely cannot say the meeting is unavailable. The retry card is the honest one.
        setPhase('retrying');
        setIsExhausted(true);
      });
  }, [meetingId]);

  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);

  useEffect(() => {
    startedAtRef.current = Date.now();
    // ⚠⚠ BOTH STARTED TOGETHER. See the module docblock.
    preloadMeetingFrame();
    attempt();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [attempt]);

  const handleRetry = useCallback((): void => {
    /*
      ⚠⚠ CANCEL THE PENDING AUTOMATIC ATTEMPT FIRST. The retry card renders as soon as
      `setPhase('retrying')` runs — i.e. DURING the back-off window — so "Try again" was starting
      a second attempt chain while the scheduled one was still armed. That meant duplicate
      `joinAsMemberAction` calls (duplicate Daily token mints, each valid until scheduled end +
      24h and non-revocable), `timerRef.current` overwritten so the orphaned timer could never be
      cleared on unmount, and `failureCountRef` reset underneath a live chain.
    */
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    failureCountRef.current = 0;
    setIsExhausted(false);
    startedAtRef.current = Date.now();
    setPhase('connecting');
    attempt();
  }, [attempt]);

  /*
    ⚠⚠ THE ENVELOPE IS **PARSED**, NOT READ. `join-api-client.ts` returns `parsed as T` — an
    unchecked cast of an external JSON body — and everything beside the grant's five fields is
    consumed here, outside `validateGrant`'s seam. `back-to-context.ts`'s table is TOTAL at
    compile time and was an unguarded lookup at runtime, so an unexpected `context.type` was
    `undefined(...)`: a TypeError on the join path, on the surface where failing is most
    expensive. Each field degrades to `null` on its own, and `null` is a live path everywhere.
  */
  const envelope = useMemo(() => parseMemberJoinEnvelope(response), [response]);
  const context = envelope.context;
  const subject = useMemo(
    () => (context === null ? null : { contextType: context.type, contextId: context.id }),
    [context]
  );
  // ⚠ STABLE IDENTITIES, so `MeetingRouteContextProvider`'s memo is not defeated on every render.
  const backTo = useMemo(
    () => (subject === null ? DASHBOARD_BACK_TO : resolveBackTo(subject)),
    [subject]
  );
  const contextNoun = useMemo(() => resolveContextNoun(subject), [subject]);

  /**
   * ⚠⚠ RULING R10 — WHO THE WAITING STAGE IS WAITING FOR, ASSEMBLED HERE AND NOWHERE ELSE.
   *
   * `viewerRole` is the SERVER's resolved side (`authorizeMeetingParticipation`), so the stage
   * branches on a fact about the room rather than on a lens. All three pieces or none: a subject
   * with a real name and a placeholder time is exactly how `"the scheduled time"` shipped as a
   * literal string. The label is formatted in the VIEWER's timezone, in the browser.
   */
  const waiting = useMemo(
    () =>
      resolveWaitingSubject({
        viewerRole: envelope.viewerRole,
        counterpartyFirstName: envelope.counterpartyFirstName,
        scheduledStartLabel: formatScheduledStartLabel(envelope.scheduledStart),
      }),
    [envelope]
  );

  /**
   * ⚠ WHERE A MEMBER GOES WHEN THE CALL ENDS: BAL-389's end-of-call screen at
   * `/meetings/{id}/end`, which landed in `02cd447` while this branch was open. That ticket's
   * `page.tsx` names THIS handler as its only producer — *"BAL-435 owns the in-meeting route and
   * the Leave handler, and supplies the producer with a one-line
   * `router.replace('/meetings/{id}/end')`"* — and forbids any other entry point.
   *
   * ⚠ `replace`, NOT `push`. The call is over and the room is gone; leaving it in history means
   * Back returns a person to a dead frame that can only re-render its failure state.
   *
   * ⚠ NO QUERY PARAM, AND THE `reason` IS DELIBERATELY NOT FORWARDED. The end-of-call page
   * declares no `searchParams` prop and states it "reads no query string", so `?ended=host`
   * would be a value nothing consumes — it resolves what to say from server state instead.
   *
   * ⚠ HENCE THE HANDLER TAKES NO PARAMETER AT ALL. Every exit lands on the same URL, so naming
   * a `reason` it does not read would be a claim this function does not keep. It still satisfies
   * the `(reason: MeetingExitReason) => void` prop — a function may ignore trailing arguments —
   * and the reason is not lost: the frame records it on the leave analytics event before calling
   * this. If the end-of-call screen ever needs to distinguish an ejection from a walk-out, that
   * is a server-state question there, not a query param here.
   */
  const handleExit = useCallback((): void => {
    router.replace(`/meetings/${meetingId}/end`);
  }, [meetingId, router]);

  /**
   * BAL-436 — ⚠⚠ **THE SIDE-PANEL REGISTRATION, AND THE ONLY PLACE IT IS BUILT.**
   *
   * ⚠ IT CLOSES OVER `meetingId`, WHICH IS WHY THAT ID IS NOT ON `MeetingPanelRegistration`.
   * No panel component ever handles a meeting id it could send to the wrong action — the
   * closure IS the containment.
   *
   * ⚠ MEMOISED ON `meetingId` ALONE. Every Server Action reference is a module-level import
   * and therefore already stable, so this object's identity changes only when the meeting
   * does — which is what keeps `MeetingRouteContextProvider`'s own `useMemo` from being
   * defeated on every render.
   *
   * ⚠⚠ BOTH GUEST MOUNTS PASS NOTHING AND THEREFORE READ `null` — `join-control.tsx` and
   * `lobby-client.tsx` do not mount this provider at all. That is STRUCTURAL, not a check: a
   * token-authenticated guest satisfies none of the four gates behind this panel
   * (`requireAuth` on the guests route, `requireUser()` on both file reads,
   * `requireOnboardedUser()` on both file writes). ⚠ GUEST FILE ACCESS STAYS CLOSED AND IS
   * **BAL-445**'s to open — one guest-authenticated read session, shared with BAL-437's chat.
   */
  const panels = useMemo<MeetingPanelRegistration>(
    () => ({
      joinLinkUrl,
      loadGuests: () => getMeetingGuestsAction({ meetingId }),
      inviteGuests: (emails) => inviteMeetingGuestsAction({ meetingId, emails }),
      decideAdmission: (guestId, decision) =>
        decideGuestAdmissionAction({ meetingId, guestId, decision }),
      resendLink: (guestId) => resendGuestLinkAction({ meetingId, guestId }),
      files: {
        list: () => listMeetingFilesAction({ meetingId }),
        requestUpload: (input) => requestMeetingFileUploadAction({ meetingId, ...input }),
        // ⚠ `source: 'files_tab'` IS FIXED HERE. The Files panel is one of the two in-call
        // entry points and it always knows which it is; letting a component choose would put a
        // funnel dimension in the hands of a caller that has no reason to vary it.
        confirmUpload: (input) =>
          confirmMeetingFileUploadAction({ meetingId, ...input, source: 'files_tab' }),
        download: (fileId) => getMeetingFileDownloadAction({ meetingId, fileId }),
      },
      /**
       * BAL-437 — ⚠⚠ `null` ⇒ NO CHAT SLOT. `hasChat` is the RSC's verdict, so the control is
       * absent from first paint rather than after a round trip.
       *
       * ⚠⚠ `confirmUpload` BINDS `source: 'chat'` — THE MIRROR OF `'files_tab'` ABOVE, and the
       * only difference between the two entry points. Both reach the SAME action and therefore
       * the same single `publishMeetingEvent`, which is what makes "one shared fan-out"
       * structural. Letting a component choose the source would put a funnel dimension in the
       * hands of a caller with no reason to vary it.
       */
      chat: hasChat
        ? {
            fetchThread: (before) => fetchMeetingThreadAction({ meetingId, before }),
            postMessage: (body) => postMeetingMessageAction({ meetingId, body }),
            requestUpload: (input) => requestMeetingFileUploadAction({ meetingId, ...input }),
            confirmUpload: (input) =>
              confirmMeetingFileUploadAction({ meetingId, ...input, source: 'chat' }),
          }
        : null,
      /**
       * BAL-437 — ⚠⚠ `null` ⇒ NO REACTIONS CONTROL AND NO ABLY CLIENT AT ALL.
       *
       * ⚠ THE MEETING CHANNEL IS ALWAYS PRESENT WHEN REALTIME IS: reactions are meeting-grain
       * and need no conversation anchor. The conversation channel is `null` in exactly the cases
       * `hasChat` is false.
       *
       * ⚠⚠ **THE "reactions, no chat" SHAPE IS `project_discovery` — NOT `admin`.** An earlier
       * version of this line named `admin`, which is wrong in a way worth pinning:
       * `selectPrimaryMeetingContext` DROPS admin rows, so an admin-only meeting resolves to a
       * primary context of `none` and the participation gate DENIES it outright. Such a call
       * therefore gets no chat, **no reactions and no token at all** — its artefacts resolve on
       * the platform axis (ADR-1035). Same for an `ambiguous` context. `project_discovery` is
       * the shape that really does grant the meeting channel while naming no thread.
       */
      realtime: isRealtimeEnabled
        ? {
            fetchToken: () => createMeetingRealtimeTokenAction({ meetingId }),
            sendReaction: (input) => sendMeetingReactionAction({ meetingId, ...input }),
            meetingChannel: meetingChannelName(meetingId),
            conversationChannel: chatChannelName,
          }
        : null,
    }),
    [meetingId, joinLinkUrl, hasChat, isRealtimeEnabled, chatChannelName]
  );

  /**
   * BAL-134 (§7.2) — ⚠⚠ **THE ONE POLLED READ, AND THE ONLY PRODUCER OF THE SERVER MIRROR.**
   *
   * ⚠ IT WRITES NOTHING. Daily's `participant-joined` / `participant-left` events stay UI-only
   * inside the frame; presence is observed server-to-server (D1), because a browser-reported
   * join is a money input supplied by a party to the transaction. This hook creating no
   * client→server presence path is what preserves `join-link-never-writes.test.ts`'s posture.
   *
   * ⚠ `enabled` WAITS FOR THE GRANT. Before the member join resolves there is nothing to mirror
   * and the read would 404 on a meeting the viewer has not been admitted to.
   */
  const loadState = useCallback(() => getMeetingStateAction({ meetingId }), [meetingId]);
  const { snapshot, stopReason, retry } = useMeetingStatePoll({
    load: loadState,
    enabled: response !== null,
  });

  /**
   * ⚠ `'pre-start'` UNTIL THE FIRST POLL LANDS — exactly what BAL-435 hard-coded, so the window
   * before the mirror arrives is the shipped behaviour rather than a flash of a later phase.
   */
  const waitingPhase = snapshot?.phase ?? 'pre-start';
  /** ⚠ MEMOISED: `resolveTopBarClock` returns a fresh object, and this joins the provider's memo. */
  const clock = useMemo(() => resolveTopBarClock({ snapshot }), [snapshot]);

  /**
   * BAL-134 — ⚠⚠ **THE FACTS THE WAITING COPY MAY NOT ASSERT WITHOUT**, lifted off the mirror.
   *
   * Each one exists because a sentence was found claiming something the browser could not know:
   * the no-show floor (a hard-coded "15-minute" literal that drifts from an overridden server),
   * the settled outcome (a terminal status is NOT evidence of a no-show settlement), and whether
   * an expert has actually been OBSERVED present (the copy claimed counted time inside the
   * webhook-observation window, where the server measures zero).
   *
   * ⚠ ALL THREE DEGRADE TO "UNKNOWN" WITH NO MIRROR, and every string is written so that the
   * unknown answer claims LESS. ⚠ `expertPresenceOpen === null` — an api that has not yet
   * deployed the field — keeps the shipped behaviour by falling back to "ever joined".
   */
  const waitingFacts = useMemo<WaitingFacts>(() => {
    if (snapshot === null) return UNKNOWN_WAITING_FACTS;
    return {
      noShowFloorMinutes: snapshot.noShowFloorMinutes,
      outcome: snapshot.outcome,
      expertPresenceObserved:
        snapshot.expertPresenceOpen ?? snapshot.clocks.expertFirstJoinedAt !== null,
    };
  }, [snapshot]);

  /**
   * BAL-134 — ⚠⚠ **THE ERROR STATE OF THE FOUR, AND THE ONE THAT WAS MISSING.**
   *
   * `isStopped` was computed by the hook and DISCARDED here, so after eight failures or a
   * refusal the poll stopped permanently and nothing told anybody: the phase froze mid-wait and
   * an expert would never reach *"you're free to leave"*. This is the quiet degradation notice —
   * same posture as the `JoinRetryNotice` above, and deliberately NOT a toast, because the
   * condition persists and a toast does not.
   *
   * ⚠ `'terminal'` IS EXCLUDED. A poll that stopped because the meeting ENDED has nothing to
   * reconnect to; the mirror is complete and the route is already navigating away.
   */
  const hasStalled = stopReason === 'unreachable';

  /**
   * BAL-134 / ADR-1049 — ⚠⚠ **THE END ACTION, WIRED ONLY ON THE MEMBER ROUTE.**
   *
   * Both guest surfaces mount no provider, so they read `null` structurally — the second,
   * independent half of the `canEndMeeting` gate. ⚠ The UI gate is not the gate: `apps/api`
   * re-resolves both authority axes behind the tenancy gate on every call and collapses every
   * denial to `404`.
   */
  const endMeeting = useCallback((): Promise<EndMeetingResult> => {
    return endMeetingAction({ meetingId });
  }, [meetingId]);

  if (phase === 'unavailable') {
    return (
      <CallShell>
        <JoinUnavailableNotice headingRef={headingRef} />
        <DashboardLink />
      </CallShell>
    );
  }

  if (phase === 'retrying') {
    return (
      <CallShell>
        <JoinRetryNotice headingRef={headingRef} onRetry={handleRetry} />
        {isExhausted ? (
          <p className="text-muted-foreground mt-4 max-w-md text-center text-[12.5px] leading-relaxed">
            {MEMBER_JOIN_EXHAUSTED_LINE}
          </p>
        ) : null}
        <DashboardLink />
      </CallShell>
    );
  }

  if (phase === 'connecting' || response === null) {
    return (
      <CallShell>
        <MeetingConnectingCard headingRef={headingRef} />
      </CallShell>
    );
  }

  return (
    <MeetingRouteContextProvider
      meetingId={meetingId}
      viewerName={viewerName}
      title={context?.title ?? null}
      backTo={backTo}
      contextNoun={contextNoun}
      waiting={waiting}
      onExit={handleExit}
      panels={panels}
      waitingPhase={waitingPhase}
      waitingFacts={waitingFacts}
      clock={clock}
      endMeeting={endMeeting}
    >
      <div className="relative h-full w-full">
        {hasStalled ? <MeetingStateStalledNotice onRetry={retry} /> : null}
        <MeetingCallSurface
          roomUrl={response.roomUrl}
          token={response.token}
          isOwner={response.isOwner}
          /*
            ⚠⚠ THE SERVER'S END-AUTHORITY VERDICT, PASSED THROUGH — NEVER RE-DERIVED, AND NEVER
            `isOwner`. `isOwner` is `hasEngagementCapability(HOST_MEETINGS)` and is the only
            input to the Daily owner token; `canEndMeeting` is that OR the client principal's
            `CONSUME_CREDITS` membership, composed in `apps/api`'s `authorize-end-meeting.ts`.
          */
          canEndMeeting={response.canEndMeeting}
          expiresAt={response.expiresAt}
          participantId={response.participantId}
          headingRef={headingRef}
        />
      </div>
    </MeetingRouteContextProvider>
  );
}

/**
 * BAL-134 — ⚠⚠ **THE POLL GAVE UP. SAY SO, QUIETLY, AND KEEP THE AFFORDANCE LIVE.**
 *
 * ⚠ IT DOES NOT CLAIM THE CALL IS OVER, AND THAT DISTINCTION IS THE WHOLE POINT: the Daily
 * connection is untouched — audio, video and the room are fine — and only the *status* line has
 * stopped advancing. "Disconnected" would be false and alarming mid-call.
 *
 * ⚠ AN `<output>`, NOT `role="status"` — SonarCloud S6819. It carries the same implicit live
 * region, so the degradation is announced once, when it happens.
 *
 * ⚠ `pointer-events-none` ON THE WRAPPER, RE-ENABLED ON THE CARD: it floats over a live video
 * stage and must not swallow a click aimed at a tile, but its own button has to remain pressable.
 */
function MeetingStateStalledNotice({
  onRetry,
}: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
      <output
        aria-live="polite"
        className="bg-card/95 border-border text-muted-foreground pointer-events-auto flex items-center gap-3 rounded-lg border px-3 py-2 text-[12.5px] shadow-lg backdrop-blur"
      >
        {MEETING_STATE_STALLED_COPY}
        <button
          type="button"
          onClick={onRetry}
          className="text-foreground hover:bg-muted focus-visible:ring-ring min-h-9 rounded-md px-2 font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {MEETING_STATE_RETRY_LABEL}
        </button>
      </output>
    </div>
  );
}

/** The centred well every pre-call notice renders in. */
function CallShell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4 py-8">
      {children}
    </div>
  );
}

/** ⚠ The dashboard fallback — the context is not known yet on any of the pre-call states. */
function DashboardLink(): React.JSX.Element {
  return (
    <Link
      href={DASHBOARD_BACK_TO.href}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center rounded-lg px-2 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      {DASHBOARD_BACK_TO.label}
    </Link>
  );
}
