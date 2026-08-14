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
 * REJECTED (ruling R2). Do not "correct" any string below back toward it. `waiting-copy.test.ts`
 * asserts the phrase appears nowhere in this module.
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

export interface WaitingCopyInput {
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
 * THE EXPERT IS WAITING; the CLIENT is the absent party. R2 — Option A, whole.
 *
 * ⚠ "counted from {start}" is exact in the common case (an expert who joined at or after the
 * scheduled start) and is the phrase BAL-134's help doc will use. It also fixes the shipped
 * patch's own imprecision: "counting the moment you join" over-promises to an expert who
 * arrived early.
 */
const CLIENT_ABSENT: Record<WaitingPhase, CopyBuilder> = {
  'pre-start': ({ counterpartyFirstName, scheduledStartLabel }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Due to start at ${scheduledStartLabel}. Your time starts counting then — there's no waiting room, so ${counterpartyFirstName} will come straight in.`,
  }),
  running: ({ counterpartyFirstName, scheduledStartLabel }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Your time is counted from ${scheduledStartLabel}. Nothing for you to do.`,
  }),
  near: ({ counterpartyFirstName }) => ({
    title: `Waiting for ${counterpartyFirstName} to join`,
    body: `Still counting. If ${counterpartyFirstName} doesn't arrive, this settles as a no-show at the 15-minute mark.`,
  }),
  settled: ({ counterpartyFirstName }) => ({
    title: `${counterpartyFirstName} didn't join`,
    body: "Settled as a no-show at the 15-minute minimum. You're free to leave — your recap and payout summary will be emailed.",
  }),
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
  settled: ({ counterpartyFirstName }) => ({
    title: `${counterpartyFirstName} didn't make it`,
    body: "We're sorry this didn't happen. Nothing has been charged and your hold has been released. We'll be in touch to get you rebooked.",
  }),
};

const WAITING_COPY: Record<WaitingAbsentParty, Record<WaitingPhase, CopyBuilder>> = {
  client: CLIENT_ABSENT,
  expert: EXPERT_ABSENT,
};

/** ⚠ TOTAL over both parties × all four phases — the `Record` types are the proof. */
export function waitingCopyFor(
  absentParty: WaitingAbsentParty,
  phase: WaitingPhase,
  input: WaitingCopyInput
): WaitingCopy {
  return WAITING_COPY[absentParty][phase](input);
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
 */
export function resolveWaitingCopy(
  phase: WaitingPhase,
  subject: WaitingSubject | null
): WaitingCopy {
  if (subject === null) return NEUTRAL_WAITING_COPY;
  return waitingCopyFor(subject.absentParty, phase, {
    counterpartyFirstName: subject.counterpartyFirstName,
    scheduledStartLabel: subject.scheduledStartLabel,
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
