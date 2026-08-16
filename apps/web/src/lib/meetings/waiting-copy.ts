/**
 * BAL-435 — THE WAITING-STAGE COPY, AS DATA. **One module, twelve strings, zero JSX literals.**
 *
 * ⚠ IT IS DATA RATHER THAN INLINE JSX so the component tests import THE SAME CONSTANTS the
 * component renders — a test cannot pass against copy that drifted. CLAUDE.md's data-driven
 * rule, applied to prose.
 *
 * ── ⚠⚠ THE CLOCK RULE THESE STRINGS ARE WRITTEN TO (BAL-134, amended 2026-07-31) ───────────
 *
 * The expert-present clock starts at **the LATER of the scheduled start and the expert's actual
 * join**. Arriving at 09:55 for a 10:00 call earns nothing extra; joining at 10:05 means the
 * no-show settles at 10:20, not 10:15. **If the expert has not joined, nothing is counted at
 * all.**
 *
 * ⚠⚠ BAL-435's OWN FINDING TEXT ("counted from the scheduled start") IS STALE AND WAS EXPLICITLY
 * REJECTED (ruling R2). Do not "correct" any string below back toward it.
 *
 * ⚠⚠ AND DO NOT RE-ADD THE PHRASE-GREP THAT USED TO GUARD IT. `waiting-copy.test.ts` asserted
 * that the literal `"scheduled start"` appeared in no string, and it PASSED for months over a
 * `running` body reading *"Your time is counted from {scheduledStartLabel}"* — because the string
 * interpolated a FORMATTED TIME, so the banned phrase never appeared while the false claim it was
 * written to stop survived intact. Every sentence here is now pinned by EQUALITY against its exact
 * expected text; a grep cannot see a claim assembled from a variable.
 *
 * ── RULINGS THIS MODULE IMPLEMENTS ──────────────────────────────────────────────────────────
 *
 *   · R2 — the EXPERT-side progression is **Option A, whole**. Not the A/B hybrid.
 *   · R3 — the CLIENT's waiting line is `balo-in-meeting-ui.jsx:236` **VERBATIM**. The patch's
 *          "once you're both in" variant is NOT taken. It is the `pre-start` line: before the
 *          start nothing is wrong yet, and it is the only phase reachable in production today.
 *
 * ── ⚠ WHAT IS NOT HERE, STATED SO IT IS NOT MISTAKEN FOR AN OMISSION ────────────────────────
 *
 * `waiting-state-patch.jsx`'s client-lens progression has FIVE distinct sentences across FOUR
 * phases once R3's `:236` line takes `pre-start`. The one that does not fit — "We're sorry —
 * we're still trying to reach {Name}. You haven't been charged, and you won't be." — is the
 * middle apology, and the two around it already carry both facts (the operational escalation,
 * then the settlement). It returns with **BAL-134**, which owns the phase transitions and is the
 * only ticket that can introduce a fifth phase honestly.
 *
 * ── ⚠ REGISTER (BAL-134) ────────────────────────────────────────────────────────────────────
 *
 * "A quiet fact, not a countdown to a payout." Warm, gender-neutral, no urgency, no adversarial
 * framing, and never "you'll be paid if they don't show" — which would invite an expert to hope
 * for a no-show.
 */

/** WHO is missing. ⚠ Not a lens: it is a fact about the room, not about the viewer. */
export type WaitingAbsentParty = 'expert' | 'client';

/**
 * How far the wait has run.
 *
 * ⚠ ONLY `pre-start` IS REACHABLE IN PRODUCTION TODAY. `meeting_presence` has no writer, so
 * `MeetingStage` supplies `pre-start` and nothing else. All four ship, and all four are pinned
 * by tests, so **BAL-134 wires the phase in with no redesign and no uncovered lines.**
 */
export type WaitingPhase = 'pre-start' | 'running' | 'near' | 'settled';

export interface WaitingCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * BAL-134 — ⚠⚠ **THE FACTS FROM THE SERVER MIRROR THAT THE COPY MAY NOT ASSERT WITHOUT.**
 *
 * Every field here exists because a sentence below was found claiming something the browser had
 * no basis for. They arrive on the polled snapshot; before the first poll lands they are all
 * {@link UNKNOWN_WAITING_FACTS}, and every string is written so that the unknown answer is
 * *quieter*, never *wronger*.
 */
export interface WaitingFacts {
  /**
   * The no-show floor in whole minutes, **as the SERVER computes it**. `null` ⇒ the server did
   * not say, and the copy then names no number at all.
   *
   * ⚠⚠ **NEVER A CONSTANT IN THIS BUNDLE.** `NO_SHOW_FLOOR_MS` is env-overridable
   * (`MEETING_NO_SHOW_FLOOR_MINUTES`) and only `apps/api` reads that env. The browser is not
   * COMPUTING a threshold here — the phase label already arrives server-computed — but it was
   * STATING one ("the 15-minute mark") as a hard-coded literal, which drifts silently from an
   * overridden server and only in the environment that was overridden. If you find yourself
   * importing `NO_SHOW_FLOOR_MS` into `apps/web` to fill this in, stop.
   */
  readonly noShowFloorMinutes: number | null;
  /**
   * The settled outcome as the server labelled it, or `null`.
   *
   * ⚠⚠ `null` IS A REAL, COMMON ANSWER, NOT AN ABSENCE — both human end paths and the abandoned
   * wait write `outcome NULL` by design (D5). It is the whole reason the `settled` copy branches:
   * a terminal status alone is NOT evidence of a money outcome.
   */
  readonly outcome: string | null;
  /**
   * Has the server **OBSERVED** an expert in the room *right now*?
   *
   * ⚠ NOT "did an expert ever join". Presence is written from Daily's webhooks server-to-server,
   * so there is a real observation window (webhook lag) in which the phase has advanced and no
   * expert interval is open. Nothing is counted in that window, and the copy must not say it is.
   */
  readonly expertPresenceObserved: boolean;
}

/**
 * ⚠ THE PRE-MIRROR VALUE: before the first poll lands, and on every surface that polls nothing.
 * Each field is the answer that makes the copy claim LESS, never more.
 */
export const UNKNOWN_WAITING_FACTS: WaitingFacts = {
  noShowFloorMinutes: null,
  outcome: null,
  expertPresenceObserved: false,
};

/** ⚠ The two outcome labels the copy branches on. Every other label takes the neutral arm. */
const OUTCOME_NO_SHOW_CLIENT = 'no_show_client';
const OUTCOME_MISSED_CALL = 'missed_call';

export interface WaitingCopyInput extends WaitingFacts {
  /** The counterparty's FIRST name. ⚠ Gender-neutral by construction — never a pronoun. */
  readonly counterpartyFirstName: string;
  /** The scheduled start, already formatted in the VIEWER's timezone. */
  readonly scheduledStartLabel: string;
}

/**
 * BAL-435 (ruling R10) — EVERYTHING THE PARTY-SPECIFIC COPY NEEDS, AS ONE VALUE THAT IS EITHER
 * WHOLLY PRESENT OR WHOLLY ABSENT.
 *
 * ⚠⚠ THAT IS THE POINT OF THE SHAPE. Three independent optional props let a caller supply two of
 * them and a placeholder for the third, which is exactly how `counterpartyFirstName="your expert"`
 * and `scheduledStartLabel="the scheduled time"` shipped as literals. One nullable object cannot
 * be half-supplied.
 *
 * ⚠ `absentParty` IS DERIVED FROM THE SERVER'S `viewerRole`, WHICH IS A FACT ABOUT THE ROOM — not
 * a lens, not `activeMode`, and never re-derived in the browser.
 */
export interface WaitingSubject {
  readonly absentParty: WaitingAbsentParty;
  readonly counterpartyFirstName: string;
  readonly scheduledStartLabel: string;
}

type CopyBuilder = (input: WaitingCopyInput) => WaitingCopy;

/**
 * ⚠ R3: THIS LINE IS `balo-in-meeting-ui.jsx:236`, BYTE FOR BYTE. Exported so the test can
 * assert equality against ONE definition rather than against a re-typed copy of it.
 */
export const CLIENT_WAITING_BODY =
  "The consultation timer starts once your expert joins. You won't be charged for waiting.";

/**
 * ⚠⚠ THE NO-SHOW FLOOR, NAMED WITH THE SERVER'S NUMBER — OR WITH NO NUMBER AT ALL.
 *
 * Falling back to a shipped `15` would re-create the exact drift {@link WaitingFacts} exists to
 * remove: a hard-coded threshold in the browser bundle wearing an interpolation, disagreeing
 * silently with a server running `MEETING_NO_SHOW_FLOOR_MINUTES`.
 *
 * ⚠ THE UNKNOWN ARM IS RE-WORDED, NOT TRUNCATED. "…settles as a no-show at the mark" is not
 * English; each fragment therefore carries its own pair, as data rather than as a branch inside
 * every sentence that needs one.
 */
const FLOOR_PHRASES = {
  /** For the FORWARD-LOOKING sentence: what happens if nobody arrives. */
  mark: {
    known: (minutes: number) => `at the ${minutes}-minute mark`,
    unknown: 'once the minimum is reached',
  },
  /** For the RETROSPECTIVE sentence: what has already been settled. */
  minimum: {
    known: (minutes: number) => `at the ${minutes}-minute minimum`,
    unknown: 'at the minimum',
  },
} as const;

function floorPhrase(minutes: number | null, kind: keyof typeof FLOOR_PHRASES): string {
  const phrases = FLOOR_PHRASES[kind];
  return minutes === null ? phrases.unknown : phrases.known(minutes);
}

/**
 * THE EXPERT IS WAITING; the CLIENT is the absent party. R2 — Option A, whole.
 *
 * ── ⚠⚠ THE ANCHOR IS **THE JOIN**, NOT THE SCHEDULED START (BAL-134) ────────────────────────
 *
 * `running` used to read *"Your time is counted from {scheduledStartLabel}."* — which renders as
 * "Your time is counted from 10:00", i.e. counted from the scheduled start, **the exact reading
 * the clock rule at the top of this file rejects.** An expert joining a 10:00 call at 10:05 is
 * anchored server-side at 10:05 and settles at 10:20; the screen promised 10:00. A five-minute
 * over-promise, on the one surface this ticket exists to make trustworthy.
 *
 * ⚠ AND THE OLD GUARD DID NOT CATCH IT: the test asserted the literal phrase "scheduled start"
 * appeared nowhere, but the string interpolated a FORMATTED TIME, so the banned phrase never
 * appeared while the false claim survived. The guard is now an equality assertion on the exact
 * expected sentence — see `waiting-copy.test.ts`.
 *
 * ⚠ `pre-start` IS JOIN-ANCHORED FOR THE SAME REASON (`waiting-state-patch.jsx:223`). The truth
 * is `max(scheduled, join)`, and "starts counting THEN" names only the first half of that.
 */
const CLIENT_ABSENT: Record<WaitingPhase, CopyBuilder> = {
  'pre-start': ({ counterpartyFirstName, scheduledStartLabel }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Due to start at ${scheduledStartLabel}. Your time starts counting the moment you join — there's no waiting room, so ${counterpartyFirstName} will come straight in.`,
  }),
  running: ({ counterpartyFirstName }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Your time is counted from when you joined. Nothing for you to do.`,
  }),
  near: ({ counterpartyFirstName, noShowFloorMinutes }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Still counting. If ${counterpartyFirstName} doesn't arrive, this settles as a no-show ${floorPhrase(noShowFloorMinutes, 'mark')}.`,
  }),
  /**
   * ⚠⚠ **A TERMINAL STATUS IS NOT EVIDENCE OF A NO-SHOW.** `resolveWaitingPhase` returns
   * `settled` for ANY terminal status with no reference to the outcome, so this arm used to
   * claim a 15-minute no-show settlement — and a payout summary — on paths that settled nothing:
   * the client principal ending the call at minute three (ADR-1049 gives them that authority),
   * the idle end, and every other human End. All three carry `outcome: null`.
   *
   * The payload has always carried the answer. `no_show_client` keeps the sentence it earned;
   * everything else gets one that states the fact (the call is over) and promises no settlement.
   */
  settled: ({ counterpartyFirstName, outcome, noShowFloorMinutes }) =>
    outcome === OUTCOME_NO_SHOW_CLIENT
      ? {
          title: `${counterpartyFirstName} didn't join`,
          body: `Settled as a no-show ${floorPhrase(noShowFloorMinutes, 'minimum')}. You're free to leave — your recap and payout summary will be emailed.`,
        }
      : {
          title: 'This call has ended',
          body: "You're free to leave. We're working out how it settles, and your recap will be emailed.",
        },
};

/**
 * THE CLIENT IS WAITING; the EXPERT is the absent party (BAL-412 / BAL-418's `missed_call`).
 *
 * ⚠ THE 5-MINUTE BALO ALERT IS OPERATIONAL AND HAS NO CUSTOMER-FACING UI beyond the `near`
 * sentence below. Do not surface "we've alerted the team" as a toast or a banner.
 */
const EXPERT_ABSENT: Record<WaitingPhase, CopyBuilder> = {
  // ⚠ R3 — VERBATIM. Do not reword, do not swap in the patch's "once you're both in" variant.
  'pre-start': ({ counterpartyFirstName }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: CLIENT_WAITING_BODY,
  }),
  running: ({ counterpartyFirstName }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `${counterpartyFirstName} hasn't joined yet. Nothing is being charged — the timer only starts once they're here.`,
  }),
  near: ({ counterpartyFirstName }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Still no sign of ${counterpartyFirstName}. We've flagged this to the Balo team and someone is looking into it. You haven't been charged.`,
  }),
  /**
   * ⚠ THE SAME RULE AS THE EXPERT SIDE, MIRRORED: "your hold has been released" is a MONEY claim
   * and only the `missed_call` outcome is evidence for it. A call the client themselves ended at
   * minute three is terminal with `outcome: null` and has released nothing yet.
   *
   * ⚠⚠ THE `missed_call` COPY IS **UNCHANGED, INCLUDING ITS DELIBERATE ABSENCE OF A REBOOKING
   * CTA.** "We'll be in touch" is a promise a human keeps; a button here would ask a client who
   * has just been stood up to do the work of rescheduling.
   */
  settled: ({ counterpartyFirstName, outcome }) =>
    outcome === OUTCOME_MISSED_CALL
      ? {
          title: `${counterpartyFirstName} didn't make it`,
          body: "We're sorry this didn't happen. Nothing has been charged and your hold has been released. We'll be in touch to get you rebooked.",
        }
      : {
          title: 'This call has ended',
          body: "You haven't been charged for waiting. We're working out the details and will confirm by email.",
        },
};

const WAITING_COPY: Record<WaitingAbsentParty, Record<WaitingPhase, CopyBuilder>> = {
  client: CLIENT_ABSENT,
  expert: EXPERT_ABSENT,
};

/**
 * BAL-134 — ⚠⚠ **THE PHASE LABEL ALONE CANNOT SAY "THE EXPERT HAS NOT BEEN SEEN YET".**
 *
 * Presence is observed server-to-server from Daily (D1), so there is a real window — webhook lag,
 * seconds — in which `resolveWaitingPhase` has already returned `running` while no expert
 * interval is open. In that window the server measures `expertPresentMs` as **ZERO**, the TopBar
 * chip correctly reads "Not started" (it gates on presence), and the body was simultaneously
 * saying *"Your time is counted…"*. Two contradictory statements on one screen, and the copy was
 * the one that was wrong — the inverse of the failure this ticket exists to fix, and a breach of
 * phase 1's rule that nothing counted means nothing claimed.
 *
 * So a counting phase with no observed expert falls back to the `pre-start` sentence, which
 * states when counting BEGINS and asserts no elapsed time. Only the expert-side progression is
 * affected: the client-side strings claim no counted time on any phase.
 *
 * ⚠ IT DOES NOT TOUCH `settled`. A terminal meeting is terminal whether or not anybody is still
 * in the room, and that arm already branches on the outcome rather than on a clock.
 */
function effectivePhase(
  absentParty: WaitingAbsentParty,
  phase: WaitingPhase,
  expertPresenceObserved: boolean
): WaitingPhase {
  if (absentParty !== 'client') return phase;
  if (expertPresenceObserved) return phase;
  return phase === 'running' || phase === 'near' ? 'pre-start' : phase;
}

/** ⚠ TOTAL over both parties × all four phases — the `Record` types are the proof. */
export function waitingCopyFor(
  absentParty: WaitingAbsentParty,
  phase: WaitingPhase,
  input: WaitingCopyInput
): WaitingCopy {
  const resolved = effectivePhase(absentParty, phase, input.expertPresenceObserved);
  return WAITING_COPY[absentParty][resolved](input);
}

/**
 * ⚠⚠ RULING R10 — **THE COPY WHEN WE DO NOT KNOW WHO IS MISSING.** Both GUEST mounts land here,
 * structurally: they do not mount the route provider, so no `viewerRole`, no counterparty name
 * and no scheduled start ever reach them.
 *
 * ⚠⚠ IT NAMES **NO PARTY'S CLOCK**, AND THAT IS THE WHOLE REQUIREMENT. Not "you won't be charged"
 * (a promise that is meaningless to the person being paid), not "your time is counted" (a promise
 * that is false for a client), and not "your expert" as a literal. Every sentence here is true of
 * every viewer on every mount, which is the only kind of sentence this state is entitled to.
 */
export const NEUTRAL_WAITING_COPY: WaitingCopy = {
  title: 'Waiting for the others to join',
  body: "You're the only one here so far. There's no waiting room, so anyone else joining comes straight in.",
};

/**
 * The copy for this phase, or the neutral copy when the subject is unknown.
 *
 * ⚠ `subject === null` IS A LIVE PATH, NOT A DEFENSIVE ONE — see {@link NEUTRAL_WAITING_COPY}.
 *
 * ⚠ THE SUBJECT AND THE FACTS COME FROM **DIFFERENT SOURCES** AND ARE THEREFORE TWO ARGUMENTS:
 * the subject is assembled once from the join envelope (who is missing, and from when), while
 * the facts arrive on every tick of the polled mirror. Folding the facts into `WaitingSubject`
 * would break R10's "wholly present or wholly absent" guarantee, because a guest mount has a
 * `null` subject and would still need somewhere to put an unknown floor.
 */
export function resolveWaitingCopy(
  phase: WaitingPhase,
  subject: WaitingSubject | null,
  facts: WaitingFacts
): WaitingCopy {
  if (subject === null) return NEUTRAL_WAITING_COPY;
  return waitingCopyFor(subject.absentParty, phase, {
    counterpartyFirstName: subject.counterpartyFirstName,
    scheduledStartLabel: subject.scheduledStartLabel,
    ...facts,
  });
}

/** Which glyph the waiting avatar wears. ⚠ Never colour alone — the copy carries the meaning. */
export type WaitingIconKind = 'spinner' | 'no_show' | 'missed_call';

/**
 * ⚠ `null` (nobody named) ALWAYS SPINS: a settled glyph asserts an outcome, and an outcome is
 * precisely what a viewer with no subject has no basis to be told.
 */
export function waitingIconKindFor(
  absentParty: WaitingAbsentParty | null,
  phase: WaitingPhase
): WaitingIconKind {
  if (absentParty === null || phase !== 'settled') return 'spinner';
  return absentParty === 'expert' ? 'missed_call' : 'no_show';
}
