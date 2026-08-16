'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Loader2, Video } from 'lucide-react';
import { toast } from 'sonner';
import { MeetingCallSurface } from '@/components/balo/meetings/meeting-call-surface';
import {
  JoinRetryNotice,
  JoinUnavailableNotice,
  JoinWaitingCard,
} from '@/components/balo/meetings/join-notice-card';
import {
  JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
  JOIN_UNAVAILABLE_TITLE,
  LOBBY_LONG_WAIT_AFTER_MS,
} from '@/lib/meetings/lobby';
import { useAdmissionPoll } from '@/lib/meetings/use-admission-poll';
import { useFocusOnTransition } from '@/lib/meetings/use-focus-on-transition';
import { pollGuestAdmissionAction } from '../_actions/poll-guest-admission';
import type { JoinGrant } from '@/lib/meetings/join-api-client';

/**
 * BAL-132 — the INVITED guest's join surface, plus the D10 viewer-local time swap.
 *
 * ⚠⚠ **IT OWNS THE WHOLE INVITATION CARD, NOT A CONTROL INSIDE IT** (fix for the nested-card
 * defect). The invitation's own content still comes from the RSC and arrives as `children`;
 * this component supplies the `<article>` wrapper, the join affordance and the closing lines —
 * so that when the guest is admitted the call surface **REPLACES** the card instead of being
 * nested inside it.
 *
 * The nested version was wrong on three counts at once, all visible in one screenshot: TWO
 * `<h1>`s on the page (the meeting headline and the call surface's "Connecting…"); the card's
 * closing line still saying "Come back to this page when it's time" directly beneath "You're
 * in"; and — the durable cost — it handed **BAL-435** a 560px column nested inside an
 * invitation card to build a video stage in. Lifting the phase now costs one prop and saves
 * that ticket a re-layout.
 *
 * ⚠⚠ AN INVITED GUEST IS `pre_admitted`, SO THEIR FIRST CALL MINTS. There is NO visible token
 * step, no queue and no waiting card for them — which is the acceptance criterion, and it falls
 * out of the shared endpoint rather than needing a second code path.
 *
 * ⚠ BUT `waiting` IS REACHABLE AND IS NOW HANDLED PROPERLY. A host can move an invitee back
 * into the queue. That used to toast "Waiting for someone to let you in…" and reset the button
 * to `idle`, with NO polling — so the guest was left clicking a button, blind, with no way to
 * know when anything changed and no indication that clicking again was even the right move.
 * It now enters the SAME waiting treatment the anonymous lobby uses, driven by the SAME
 * `useAdmissionPoll` policy.
 *
 * ⚠ A guest who was DENIED or REVOKED gets the same `unavailable` card as everything else; the
 * api collapses those into one literal precisely so this component cannot tell them apart.
 *
 * ⚠ THE CLICK IS THE MINT, NOT A PAGE LOAD. This deliberately does NOT poll on mount:
 * `/join/[token]` is an emailed URL, so Gmail's proxy, Defender Safe Links detonation and MDM
 * prefetch all issue unsolicited GETs — and a mint on render would hand a live Daily credential
 * to a link scanner, repeatedly, for the whole 7-day window. The Server Action is POST-only and
 * user-initiated, which is exactly what `join-link-never-writes.test.ts` requires of anything
 * that changes participation from this route.
 *
 * ── ⚠ THE D10 HAND-OFF: THE VIEWER-LOCAL TIME SWAP ──────────────────────────────────────
 *
 * `formatScheduledWindow` renders UTC because an RSC cannot read the browser's zone — and a
 * guest is by definition not a Balo user, so there is no stored timezone either. That was
 * always a hand-off: "a viewer-local time swap belongs with BAL-132's join control, which
 * brings a client component to this route anyway." This is that component, so it discharges it.
 *
 * ⚠⚠ AND IT SWAPS **AFTER HYDRATION**, NEVER DURING RENDER. Reading `Intl` during the first
 * client render produces markup that differs from the server's and React reports a hydration
 * mismatch — so the server-rendered UTC string is what paints first, and the local string
 * replaces it in an effect. The UTC string is also the FALLBACK: if `Intl` is unavailable or
 * throws, the label simply stays as the server rendered it, which is correct and labelled
 * rather than merely absent.
 */

interface JoinControlProps {
  /** The raw token from the URL. ⚠ Never rendered as text — it is a live credential. */
  readonly token: string;
  readonly meetingId: string;
  /** ISO 8601 — the meeting's scheduled start, for the local-time swap. */
  readonly scheduledStartIso: string;
  /** ISO 8601 — the meeting's scheduled end. */
  readonly scheduledEndIso: string;
  /** The server-rendered UTC window. ⚠ THE FIRST PAINT AND THE FALLBACK. */
  readonly utcWindowLabel: string;
  /** An ended meeting has nothing to join. */
  readonly hasEnded: boolean;
  /** The RSC's "what happens next" line, rendered below the control. */
  readonly nextStepLine: string;
  /** When the invitation link stops working, already formatted by the RSC. */
  readonly expiresOn: string;
  /** ⚠ THE INVITATION CARD'S OWN CONTENT, rendered by the RSC. See the docblock. */
  readonly children: React.ReactNode;
}

type ControlPhase = 'idle' | 'joining' | 'waiting' | 'admitted' | 'unavailable' | 'retry_later';

/**
 * "14:00 – 15:00 AEST" in the VIEWER's zone, or `null` when the browser cannot tell us.
 *
 * ⚠ `timeZoneName: 'short'` IS NOT DECORATION. A bare wall-clock time with no zone is the
 * exact ambiguity the UTC-with-a-label choice exists to avoid; swapping to an UNLABELLED
 * local time would be strictly worse than leaving UTC.
 */
function formatLocalWindow(startIso: string, endIso: string): string | null {
  try {
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(start)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (zone === undefined) return null;

    return `${time.format(start)} – ${time.format(end)} ${zone}`;
  } catch {
    // A locked-down or exotic runtime. The server's UTC string stands.
    return null;
  }
}

export function JoinControl({
  token,
  meetingId,
  scheduledStartIso,
  scheduledEndIso,
  utcWindowLabel,
  hasEnded,
  nextStepLine,
  expiresOn,
  children,
}: Readonly<JoinControlProps>): React.JSX.Element {
  const [phase, setPhase] = useState<ControlPhase>('idle');
  const [grant, setGrant] = useState<JoinGrant | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [isLongWait, setIsLongWait] = useState(false);
  /** ⚠ STARTS AS THE SERVER'S UTC STRING, so the first client render matches the server's. */
  const [windowLabel, setWindowLabel] = useState(utcWindowLabel);

  const reduceMotion = useReducedMotion();
  const isReduced = reduceMotion === true;

  /**
   * ⚠ FOCUS FOLLOWS THE PHASE, via the SAME callback-ref policy the lobby uses — a
   * `useEffect` reading `ref.current` is a no-op under `AnimatePresence mode="wait"`, which
   * wraps the card below. See `useFocusOnTransition`.
   *
   * ⚠ KEYED ON THE RENDERED CARD, NOT ON `phase`. `joining` renders the SAME idle card with a
   * spinner in its button — the `<motion.div>` below deliberately reuses the `idle` key for
   * exactly that reason — so treating it as a transition would yank focus off the button the
   * guest just pressed, mid-press.
   */
  const headingRef = useFocusOnTransition(phase === 'joining' ? 'idle' : phase);

  useEffect(() => {
    const local = formatLocalWindow(scheduledStartIso, scheduledEndIso);
    if (local !== null) {
      setWindowLabel(local);
    }
  }, [scheduledStartIso, scheduledEndIso]);

  useEffect(() => {
    if (phase !== 'waiting') {
      setIsLongWait(false);
      return;
    }
    const startedAt = waitingSince ?? Date.now();
    const remaining = LOBBY_LONG_WAIT_AFTER_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      setIsLongWait(true);
      return;
    }
    const timer = setTimeout(() => setIsLongWait(true), remaining);
    return () => clearTimeout(timer);
  }, [phase, waitingSince]);

  const handleAdmitted = useCallback((admittedGrant: JoinGrant): void => {
    setGrant(admittedGrant);
    setPhase('admitted');
  }, []);

  const handleExhausted = useCallback((outcome: 'unavailable' | 'retry_later'): void => {
    setPhase(outcome);
  }, []);

  /**
   * ⚠ THE SAME POLICY THE ANONYMOUS LOBBY USES — cadence, back-off, retryable-vs-terminal,
   * `Retry-After`. Enabled ONLY in `waiting`, so an emailed link is never polled on mount.
   */
  useAdmissionPoll({
    meetingId,
    guestToken: phase === 'waiting' ? token : null,
    waitingSince,
    onAdmitted: handleAdmitted,
    onExhausted: handleExhausted,
  });

  const handleJoin = useCallback((): void => {
    if (phase === 'joining') return;
    setPhase('joining');

    // ⚠ NOT AWAITED, AND NOT `void`-PREFIXED — see the note on the lobby's `handleSubmit`.
    pollGuestAdmissionAction({ meetingId, guestToken: token })
      .then((result) => {
        if (!result.success) {
          // ── ⚠⚠ WHICH CARD A FAILED CLICK LANDS ON, AND WHY `429` IS NOT `retryable` HERE ──
          //
          // A retryable failure on the CLICK is still terminal for the click, but it must not
          // land on the dead-link card: telling a valid invitee their link is dead because one
          // packet dropped is the worst possible answer here. So `>= 500` — an outage on OUR
          // side, reachable only after a ≥256-bit token resolved — gets `JoinRetryNotice`.
          //
          // ⚠⚠ BUT `result.retryable` IS THE **POLLING** PREDICATE, NOT THE **COPY** PREDICATE,
          // AND USING IT HERE BROKE A STATED CONTRACT. It is true for `0` / `429` / `>= 500`
          // alike, so a `429` rendered "We couldn't connect you just now" — while
          // `lobby.ts` and `poll-guest-admission.ts` BOTH state, in as many words, that **a
          // `429` MUST STAY COLLAPSED**: it fires PRE-authorization, so a distinct message
          // tells an anonymous scanner they are being counted. `useAdmissionPoll` already had
          // this right (`status >= 500 ? 'retry_later' : 'unavailable'`); this surface did not,
          // and two answers to one question is exactly the drift the shared card exists to
          // prevent. Transport (`0`) collapses too, and correctly: a click that could not leave
          // the device is indistinguishable to the visitor from a dead link, and the `.catch`
          // arm below covers the case where it genuinely threw.
          const isOutage = result.status >= 500;
          // ⚠ THE TOAST MUST NAME THE CARD THE VISITOR IS ABOUT TO SEE. It used to toast
          // `result.title` — which is `JOIN_UNAVAILABLE_TITLE` for a `429` — beside a card
          // reading "We couldn't connect you just now". Two contradictory sentences on screen
          // at once, and a test pinned it.
          toast.error(isOutage ? JOIN_TEMPORARILY_UNAVAILABLE_TITLE : JOIN_UNAVAILABLE_TITLE);
          setPhase(isOutage ? 'retry_later' : 'unavailable');
          return;
        }
        if (result.state === 'admitted') {
          setGrant(result.grant);
          setPhase('admitted');
          return;
        }
        // ⚠ A `pre_admitted` invitee should never land here — they mint on the first call. If
        // they do, a host has moved them into the queue, and "waiting" is the honest answer —
        // WITH a poll behind it, so they are not left clicking a button blind.
        setWaitingSince(Date.now());
        setPhase('waiting');
        toast.info('Waiting for someone to let you in…');
      })
      .catch(() => {
        // ⚠ THE TRANSPORT ARM — the Server Action itself threw, so NO server answered and we
        // genuinely cannot say the link is dead. `retry_later` is the honest card, and it
        // discloses nothing: it is reachable without any server involvement at all.
        //
        // ⚠ THE TOAST MATCHES THAT CARD. It used to say "This link isn't active" beside a card
        // saying "We couldn't connect you just now" — the same title/card contradiction the
        // failure arm above carried.
        toast.error(JOIN_TEMPORARILY_UNAVAILABLE_TITLE);
        setPhase('retry_later');
      });
  }, [meetingId, phase, token]);

  /** ⚠ "Try again" re-runs the SAME user-initiated mint. Nothing was persisted to clear. */
  const handleRetry = useCallback((): void => {
    setPhase('idle');
  }, []);

  /**
   * ⚠ THE PHASE→CARD MAPPING LIVES IN `JoinPhaseContent`, NOT IN AN `if`/`else if` CHAIN HERE.
   * Inlined, it pushed this component's cognitive complexity to 23 against SonarCloud's limit
   * of 15 (`sonarjs/cognitive-complexity`, which `pnpm lint:sonar:diff` enforces locally). The
   * split is along the honest seam anyway: everything above decides WHAT STATE we are in,
   * everything in that component decides WHAT THAT STATE LOOKS LIKE.
   */
  const content = (
    <JoinPhaseContent
      phase={phase}
      grant={grant}
      headingRef={headingRef}
      isLongWait={isLongWait}
      windowLabel={windowLabel}
      hasEnded={hasEnded}
      isReduced={isReduced}
      nextStepLine={nextStepLine}
      expiresOn={expiresOn}
      onJoin={handleJoin}
      onRetry={handleRetry}
    >
      {children}
    </JoinPhaseContent>
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={phase === 'joining' ? 'idle' : phase}
        initial={isReduced ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={isReduced ? undefined : { opacity: 0 }}
        transition={{ duration: isReduced ? 0 : 0.18 }}
      >
        {content}
      </motion.div>
    </AnimatePresence>
  );
}

interface JoinPhaseContentProps {
  readonly phase: ControlPhase;
  readonly grant: JoinGrant | null;
  readonly headingRef: React.Ref<HTMLHeadingElement>;
  readonly isLongWait: boolean;
  readonly windowLabel: string;
  readonly hasEnded: boolean;
  readonly isReduced: boolean;
  readonly nextStepLine: string;
  readonly expiresOn: string;
  readonly onJoin: () => void;
  readonly onRetry: () => void;
  readonly children: React.ReactNode;
}

/**
 * WHICH CARD THIS PHASE RENDERS. Extracted from `JoinControl` purely to keep that component's
 * cognitive complexity under SonarCloud's threshold — the behaviour is unchanged, and the
 * branches are in the same order and mean the same things.
 *
 * ⚠ `joining` DELIBERATELY FALLS THROUGH TO THE INVITATION CARD. It is a busy state ON that
 * card (the button shows a spinner and disables), not a card of its own — which is also why
 * the `<motion.div>` in `JoinControl` reuses the `idle` key for it and why the focus hook is
 * keyed the same way. A visitor mid-click must not have the card swapped from under them.
 */
function JoinPhaseContent({
  phase,
  grant,
  headingRef,
  isLongWait,
  windowLabel,
  hasEnded,
  isReduced,
  nextStepLine,
  expiresOn,
  onJoin,
  onRetry,
  children,
}: Readonly<JoinPhaseContentProps>): React.JSX.Element {
  if (phase === 'admitted' && grant !== null) {
    // ⚠⚠ REPLACES THE INVITATION CARD. See the module docblock — this is the nested-card fix.
    return (
      <MeetingCallSurface
        roomUrl={grant.roomUrl}
        token={grant.token}
        isOwner={grant.isOwner}
        // ⚠ ALWAYS `false` ON THIS ARM, HARD-CODED SERVER-SIDE exactly as `isOwner` is: a guest
        // holds no company membership and is not on the engagement axis, so they see Leave only
        // (BAL-134 edge case 24). It is PASSED THROUGH, never defaulted here.
        canEndMeeting={grant.canEndMeeting}
        expiresAt={grant.expiresAt}
        participantId={grant.participantId}
        // ⚠ THE TRANSITION THAT MATTERS MOST — see `MeetingCallSurface.headingRef`.
        headingRef={headingRef}
      />
    );
  }
  if (phase === 'unavailable') {
    // ⚠ ALSO REPLACES THE CARD. If the link is dead, the invitation details above it are stale
    // and misleading — and this is the SAME propless card `/join/m/[meetingId]` renders.
    return <JoinUnavailableNotice headingRef={headingRef} />;
  }
  if (phase === 'retry_later') {
    return <JoinRetryNotice headingRef={headingRef} onRetry={onRetry} />;
  }
  if (phase === 'waiting') {
    return (
      <JoinWaiting headingRef={headingRef} isLongWait={isLongWait} windowLabel={windowLabel} />
    );
  }

  const isJoining = phase === 'joining';
  return (
    <article className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-6 shadow-sm sm:p-8">
      {children}

      <div className="mt-6">
        {/*
          ⚠ THE LOCAL-TIME LINE RENDERS FOR BOTH STATES. It is the D10 obligation and is
          independent of whether there is anything to join — an ended meeting's window is
          still worth reading in the viewer's own zone.
        */}
        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          Scheduled for <span className="text-foreground font-medium">{windowLabel}</span>
        </p>

        {hasEnded ? null : (
          <motion.button
            type="button"
            onClick={onJoin}
            disabled={isJoining}
            whileTap={isReduced ? undefined : { scale: 0.985 }}
            /* ⚠ `disabled:opacity-80`, NOT 60 — a 60% wash on `bg-primary` drops the label
               under 4.5:1 at the exact moment the guest is most anxious about whether the
               click registered. ⚠ `text-base sm:text-…` for the same iOS reason as the lobby
               form: this is a phone-first surface. */
            className="bg-primary text-primary-foreground focus-visible:ring-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-base font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-80 sm:text-[13.5px]"
          >
            {isJoining ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Video className="h-4 w-4" aria-hidden="true" />
            )}
            {isJoining ? 'Joining…' : 'Join the call'}
          </motion.button>
        )}
      </div>

      <p className="text-foreground mt-6 text-[13px] leading-relaxed">{nextStepLine}</p>

      <p className="text-muted-foreground border-border mt-4 border-t pt-4 text-[12.5px] leading-relaxed">
        Keep this link — it stays active until {expiresOn}, and it works from more than one device.
      </p>
      <p className="text-muted-foreground mt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </article>
  );
}

/**
 * The invited guest's waiting state — the SAME card the anonymous lobby renders, so a guest
 * who is moved into the queue sees a state that explains itself rather than a reset button.
 *
 * ⚠⚠ THE CARD IS `JoinWaitingCard`, SHARED. The wrapper, the icon, the heading and BOTH copy
 * literals used to be duplicated here and in `lobby-client.tsx` — byte-identical, in two files
 * — which is exactly the drift that had already happened to the FAILURE copy before it was
 * hoisted. This component now supplies only what differs: the viewer-local window line.
 *
 * ⚠ NO "LEAVE THE QUEUE" HERE, deliberately, and the asymmetry with the lobby is the point: an
 * invited guest's handle is the EMAILED URL, which they still have. There is nothing local to
 * clear, and a button that only returned them to a page they can reload would be theatre.
 */
function JoinWaiting({
  headingRef,
  isLongWait,
  windowLabel,
}: Readonly<{
  headingRef: React.Ref<HTMLHeadingElement>;
  isLongWait: boolean;
  windowLabel: string;
}>): React.JSX.Element {
  return (
    <JoinWaitingCard
      headingRef={headingRef}
      isLongWait={isLongWait}
      scheduledLine={
        <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">
          Scheduled for <span className="text-foreground font-medium">{windowLabel}</span>
        </p>
      }
    />
  );
}
