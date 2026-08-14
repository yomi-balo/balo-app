'use client';

import { CircleCheck, CircleSlash, Loader2, Users } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  resolveWaitingCopy,
  waitingIconKindFor,
  type WaitingFacts,
  type WaitingPhase,
  type WaitingSubject,
} from '@/lib/meetings/waiting-copy';
import { MeetingAvatar } from './meeting-avatar';

/**
 * BAL-435 — the stage's **EMPTY** state: you are here and nobody else is.
 *
 * ⚠⚠ THE COPY IS NOT IN THIS FILE. It lives in `lib/meetings/waiting-copy.ts` as data, and the
 * component test imports the SAME constants — so a test cannot pass against copy that drifted.
 *
 * ── ⚠⚠ RULING R10 — THE SUBJECT IS ONE NULLABLE VALUE, NOT THREE OPTIONAL PROPS ─────────────
 *
 * This component previously took `absentParty`, `counterpartyFirstName` and `scheduledStartLabel`
 * as three independent required props, and the frame supplied `"expert"`, `"your expert"` and
 * `"the scheduled time"` for every viewer on every mount. That showed the DELIVERING EXPERT the
 * CLIENT's billing promise — *"You won't be charged for waiting"* — on a money surface, which is
 * the exact misreading BAL-134 says makes an expert leave at minute eight and forfeit a
 * settlement they had already earned.
 *
 * So the three collapse into ONE nullable {@link WaitingSubject}: either the server told us who
 * is missing and from when, or it did not and **the copy names no party's clock**. It is
 * structurally impossible to supply a placeholder for one field and real data for the others.
 * Both GUEST mounts land on `null` because they do not mount the route provider.
 *
 * ⚠ THE PHASE IS A **PROP**, NOT DERIVED HERE. Until BAL-134's presence writer lands,
 * `MeetingStage` supplies only `'pre-start'`, so only the first phase of each progression is
 * reachable in production. All four ship and all four are covered, so BAL-134 wires the
 * transitions in with no redesign.
 *
 * ⚠ THE 5-MINUTE BALO ALERT IS OPERATIONAL AND HAS NO CUSTOMER-FACING UI beyond the one
 * sentence the copy module already carries. Do not add a toast or a banner for it.
 */

export interface WaitingStageProps {
  readonly phase: WaitingPhase;
  /** ⚠ `null` ⇒ PARTY-NEUTRAL COPY. See the module docblock — this is a live path, not a guard. */
  readonly subject: WaitingSubject | null;
  /**
   * BAL-134 — the server-mirror facts the copy may not assert without: the no-show floor in
   * minutes, the settled outcome, and whether an expert has actually been observed in the room.
   *
   * ⚠ `UNKNOWN_WAITING_FACTS` BEFORE THE FIRST POLL AND ON BOTH GUEST MOUNTS. Every string is
   * written so the unknown answer claims LESS, never more.
   */
  readonly facts: WaitingFacts;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}

export function WaitingStage({
  phase,
  subject,
  facts,
  headingRef,
}: Readonly<WaitingStageProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const { title, body } = resolveWaitingCopy(phase, subject, facts);
  const iconKind = waitingIconKindFor(subject?.absentParty ?? null, phase);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="relative">
        <WaitingAvatar name={subject?.counterpartyFirstName ?? null} />
        <span className="bg-card absolute -right-1 -bottom-1 flex h-[26px] w-[26px] items-center justify-center rounded-full">
          <WaitingGlyph kind={iconKind} reduceMotion={reduceMotion === true} />
        </span>
      </div>

      <div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-lg font-semibold outline-none"
        >
          {title}
        </h1>
        {/*
          BAL-134 — ⚠⚠ **THE PROGRESSION'S ONLY ANNOUNCEMENT LIVES HERE.**

          This paragraph is the sole carrier of the wait's progression, and it had no live region:
          a screen-reader expert waiting on a late client was never told that the wait had settled
          and that they were free to leave — the single most consequential sentence on the surface.
          `MeetingClockSlot` is correctly `aria-live="off"` (a duration announced every second is a
          denial of service), so the announcement has nowhere else to go.

          ⚠ `<output>`, NOT `role="status"` — SonarCloud S6819, and `<output>` carries the same
          implicit live-region semantics natively.

          ⚠ IT ANNOUNCES ON CONTENT CHANGE, WHICH IS EXACTLY PHASE CHANGE: this element renders no
          clock and no duration, so its text is a pure function of the phase, the subject and the
          server facts. A re-render that changes none of them changes no text, and a live region
          with unchanged text says nothing. The element is present at mount, so its initial copy is
          read as ordinary page content rather than announced as an update.
        */}
        <output
          aria-live="polite"
          className="text-muted-foreground mx-auto mt-1 block max-w-[360px] text-sm leading-relaxed"
        >
          {body}
        </output>
      </div>
    </div>
  );
}

/**
 * ⚠ NO NAME ⇒ NO INITIALS. A deterministic-hue avatar reading "?" claims there is a specific
 * person we simply failed to name; a neutral glyph says what is actually true — somebody else is
 * expected, and we are not going to guess who.
 */
function WaitingAvatar({ name }: Readonly<{ name: string | null }>): React.JSX.Element {
  if (name === null) {
    return (
      <span className="bg-muted/60 flex h-[72px] w-[72px] items-center justify-center rounded-full">
        <Users className="text-muted-foreground h-7 w-7" aria-hidden="true" />
      </span>
    );
  }
  return <MeetingAvatar name={name} size={72} />;
}

/**
 * ⚠ `motion-reduce:animate-none` — which is EXACTLY why the copy must never rely on a spinner to
 * mean "in progress". Every string in `waiting-copy.ts` states the situation in words.
 */
function WaitingGlyph({
  kind,
  reduceMotion,
}: Readonly<{
  kind: ReturnType<typeof waitingIconKindFor>;
  reduceMotion: boolean;
}>): React.JSX.Element {
  if (kind === 'missed_call') {
    return <CircleSlash className="text-warning h-[18px] w-[18px]" aria-hidden="true" />;
  }
  if (kind === 'no_show') {
    return <CircleCheck className="text-warning h-[18px] w-[18px]" aria-hidden="true" />;
  }
  return (
    <Loader2
      className={
        reduceMotion
          ? 'text-primary h-[18px] w-[18px]'
          : 'text-primary h-[18px] w-[18px] animate-spin motion-reduce:animate-none'
      }
      aria-hidden="true"
    />
  );
}
