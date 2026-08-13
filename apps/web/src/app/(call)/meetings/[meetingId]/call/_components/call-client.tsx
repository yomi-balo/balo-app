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
import {
  MeetingRouteContextProvider,
  type MeetingExitReason,
} from '@/lib/meetings/meeting-route-context';
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
import { joinAsMemberAction } from '@/app/join/_actions/join-as-member';
import type { MemberJoinResponse } from '@/lib/meetings/join-api-client';

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
}

export function CallClient({
  meetingId,
  viewerName,
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
   * ⚠ WHERE A MEMBER GOES WHEN THE CALL ENDS: the BAL-388 recap at `/meetings/{id}` — the natural
   * parent inside one URL family, and a route that EXISTS today. `?ended=host` is the reason
   * BAL-389 will render; the recap ignores an unknown query param, so this is safe now and
   * correct later.
   */
  const handleExit = useCallback(
    (reason: MeetingExitReason): void => {
      const query = reason === 'host_ended' ? '?ended=host' : '';
      router.push(`/meetings/${meetingId}${query}`);
    },
    [meetingId, router]
  );

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
    >
      <div className="h-full w-full">
        <MeetingCallSurface
          roomUrl={response.roomUrl}
          token={response.token}
          isOwner={response.isOwner}
          expiresAt={response.expiresAt}
          participantId={response.participantId}
          headingRef={headingRef}
        />
      </div>
    </MeetingRouteContextProvider>
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
