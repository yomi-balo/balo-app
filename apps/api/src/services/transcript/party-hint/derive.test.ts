import { describe, it, expect } from 'vitest';
import type { CanonicalTranscript } from '@balo/db';
import {
  precheckPartyHint,
  derivePartyHint,
  MIN_SOLE_SPEECH_MS,
  SOLE_SPEECH_DOMINANCE,
  PRESENCE_SKEW_MARGIN_MS,
  type PartyHintSkipReason,
  type DerivePartyHintInput,
  type PartyHintPresenceInterval,
} from './derive.js';
import {
  SEGMENT_START,
  MEETING_ID,
  EXPERT_USER_ID,
  CLIENT_USER_ID,
  CLIENT_GUEST_ID,
  OBSERVER_USER_ID,
  EXPERT_WAITING_HINT,
  at,
  diarizedCanonical,
  presenceRow,
  recordingSegment,
  rosterOnlyInput,
  expertWaitingInput,
} from './__fixtures__/scenarios.js';
import { renderTranscriptText } from '../llm/prompts.js';
import { dailyMultiSpeaker, dailyEmpty } from '../normalizers/__fixtures__/daily-deepgram.js';
import { normalizeDailyDeepgram } from '../normalizers/daily-deepgram.js';

/** A same-text id used for the user/guest namespacing pin. */
const SAME_TEXT_ID = '99999999-9999-4999-8999-999999999999';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Shared ad hoc `DerivePartyHintInput` builder for the tests below — `cleanedText` defaults to
 *  the exact render (the Noop-path shape), so only `canonical` + `presence` vary per scenario. */
function buildInput(
  canonical: DerivePartyHintInput['canonical'],
  presence: readonly PartyHintPresenceInterval[],
  overrides?: Partial<DerivePartyHintInput>
): DerivePartyHintInput {
  return {
    vendor: 'daily_deepgram',
    canonical,
    cleanedText: renderTranscriptText(canonical),
    meetingId: MEETING_ID,
    recording: recordingSegment(),
    presence,
    ...overrides,
  };
}

/** Shared by the party-speech-coverage-gate tests: 400s of speaker-0, 40s of speaker-1, all
 *  after 460s — a near-zero expert presence row inside the first 460s cannot, by itself, prove
 *  the expert took part in this call. */
const COVERAGE_GATE_CANONICAL = diarizedCanonical([
  ['speaker-0', 460, 700],
  ['speaker-1', 700, 740],
  ['speaker-0', 740, 900],
]);

/**
 * Single-party-window contest fixtures: speaker-0 speaks `topSec` and speaker-1 speaks
 * `nonTopSec`, both entirely inside an EXPERT-ONLY window (expert present the whole call, client
 * joins after this contest). The client then picks up a fixed 100s coverage-only turn, safely
 * past the contest PLUS the skew margin (so it never enters the expert-only sole region) and
 * safely inside the client's own span (so the party speech coverage gate clears comfortably for
 * both sides without touching the sideLeader computation under test).
 */
const CONTEST_COVERAGE_SEC = 100;
function buildSingleWindowContestInput(topSec: number, nonTopSec: number): DerivePartyHintInput {
  const totalSec = topSec + nonTopSec;
  const clientJoinSec = totalSec + PRESENCE_SKEW_MARGIN_MS / 1000 + 10;
  const coverageStartSec = clientJoinSec + 10;
  const canonical = diarizedCanonical([
    ['speaker-0', 0, topSec],
    ['speaker-1', topSec, totalSec],
    ['speaker-1', coverageStartSec, coverageStartSec + CONTEST_COVERAGE_SEC],
  ]);
  return buildInput(canonical, [
    presenceRow('expert', { userId: EXPERT_USER_ID }, -60, null),
    presenceRow('client', { userId: CLIENT_USER_ID }, clientJoinSec, null),
  ]);
}

/** Shared presence for the "single-party-window contradiction" tests below: expert `(-100,300)`,
 *  client `(200,∞)` — segStart=0, so the expert-only sole region is always `[0,80]`s and the
 *  client-only sole region is always `[420,900]`s, regardless of `turns`. */
function buildContraryVoiceInput(
  turns: Parameters<typeof diarizedCanonical>[0]
): DerivePartyHintInput {
  return buildInput(diarizedCanonical(turns), [
    presenceRow('expert', { userId: EXPERT_USER_ID }, -100, 300),
    presenceRow('client', { userId: CLIENT_USER_ID }, 200, null),
  ]);
}

describe('derivePartyHint — emit cases', () => {
  it('emits a roster_only hint with the exact talk-time split (40/60)', () => {
    expect(derivePartyHint(rosterOnlyInput())).toEqual({
      kind: 'hint',
      hint: {
        basis: 'roster_only',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 40 },
          { ref: 'speaker-1', talkTimePercent: 60 },
        ],
      },
    });
  });

  it('emits a presence_timing hint from an expert-only opening window', () => {
    expect(derivePartyHint(expertWaitingInput())).toEqual({
      kind: 'hint',
      hint: EXPERT_WAITING_HINT,
    });
  });

  it('emits a presence_timing hint from a client-only closing window (mapping by complement)', () => {
    // Expert present [-600, 600] (leaves at 600s); client present [-600, null] (stays). Expert
    // speaks early while both are present (no evidence either way); client speaks late at
    // [800,900]s — after the expert has left — which is sole evidence for the client side.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 100],
      ['speaker-1', 800, 900],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 600),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 50 },
          { ref: 'speaker-1', talkTimePercent: 50 },
        ],
        evidence: [{ side: 'client', speakerRef: 'speaker-1', soleSpeechMs: 100_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('both sides consistent: two evidence entries, expert first', () => {
    // Expert present [-600, 300] (leaves at 300s); client joins at 200s and stays. That leaves
    // an expert-only window early ([0,80)s after the margin) and a client-only window late
    // ([420,900]s after the margin) within the SAME segment.
    //
    // The [250,280] turn is a coverage-only addition, placed in the [200,300]s zone where
    // BOTH are recorded present so it never enters either sole region ([0,80]s / [420,900]s) —
    // it counts toward BOTH parties' coverage (expert: 60_000/100_000 = 60%; client:
    // 70_000/100_000 = 70%), clearing the party speech coverage floor. Percentages recomputed
    // accordingly; the pinned evidence (30_000 / 40_000) is unaffected.
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 40],
      ['speaker-1', 500, 540],
      ['speaker-1', 250, 280],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 300),
      presenceRow('client', { userId: CLIENT_USER_ID }, 200, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 30 },
          { ref: 'speaker-1', talkTimePercent: 70 },
        ],
        evidence: [
          { side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 30_000 },
          { side: 'client', speakerRef: 'speaker-1', soleSpeechMs: 40_000 },
        ],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('sole speech below MIN_SOLE_SPEECH_MS (2999ms) gives roster_only', () => {
    const result = buildSoleSpeechBoundaryResult(MIN_SOLE_SPEECH_MS - 1);
    expect(result.kind).toBe('hint');
    if (result.kind === 'hint') {
      expect(result.hint.basis).toBe('roster_only');
    }
  });

  it('sole speech AT MIN_SOLE_SPEECH_MS (3000ms) gives presence_timing (boundary pin)', () => {
    const result = buildSoleSpeechBoundaryResult(MIN_SOLE_SPEECH_MS);
    expect(result).toEqual({
      kind: 'hint',
      hint: expect.objectContaining({
        basis: 'presence_timing',
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: MIN_SOLE_SPEECH_MS }],
      }),
    });
  });

  it('margin pin: an utterance ending 119s before the other party joins is NOT evidence (roster_only)', () => {
    const result = buildMarginPinResult(119);
    expect(result.kind).toBe('hint');
    if (result.kind === 'hint') {
      expect(result.hint.basis).toBe('roster_only');
    }
  });

  it('margin pin: an utterance ending 121s before the other party joins IS evidence (presence_timing)', () => {
    const result = buildMarginPinResult(121);
    expect(result).toEqual({
      kind: 'hint',
      hint: expect.objectContaining({
        basis: 'presence_timing',
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 10_000 }],
      }),
    });
  });

  it('a segment straddling a sole-region boundary contributes 0 sole speech (not merely reduced)', () => {
    // Same expert(-1000,null)/client(300,null) shape as the margin pin (sole cutoff at 180s).
    // The speaker-0 turn [170,185]s straddles that cutoff, so none of it counts as sole — the
    // result degrades all the way to roster_only rather than a partial-credit presence_timing.
    // The [500,550] turn is a client-coverage-only addition — the expert never leaves, so it can
    // never become client sole evidence either; it only feeds the coverage gate.
    const canonical = diarizedCanonical([
      ['speaker-0', 170, 185],
      ['speaker-1', 400, 410],
      ['speaker-1', 500, 550],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -1000, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
    ]);
    const result = derivePartyHint(input);
    expect(result.kind).toBe('hint');
    if (result.kind === 'hint') {
      expect(result.hint.basis).toBe('roster_only');
    }
  });

  it('anchoring pin: moving the segment start +300s turns presence_timing into roster_only', () => {
    const shifted = derivePartyHint(
      expertWaitingInput({ recording: recordingSegment({ startedAt: at(300) }) })
    );
    expect(shifted).toEqual({
      kind: 'hint',
      hint: {
        basis: 'roster_only',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 44 },
          { ref: 'speaker-1', talkTimePercent: 56 },
        ],
      },
    });
  });

  it('an open interval (leftAt: null) counts as present all the way to the segment end', () => {
    // Client leaves at 100s; expert's interval is OPEN (leftAt: null). A turn at [890,900]s —
    // the last 10s of the 900s segment — is sole evidence for the expert ONLY if the open
    // interval is treated as covering the segment's true end, not some earlier default.
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 40],
      ['speaker-1', 890, 900],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, 100),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 75 },
          { ref: 'speaker-1', talkTimePercent: 25 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-1', soleSpeechMs: 10_000 }],
        expertRef: 'speaker-1',
        clientRef: 'speaker-0',
      },
    });
  });
});

/** Builds the shared "sole-speech boundary" scenario, parameterized on the sole turn's duration. */
function buildSoleSpeechBoundaryResult(soleTurnMs: number): ReturnType<typeof derivePartyHint> {
  const soleTurnSec = soleTurnMs / 1000;
  const canonical = diarizedCanonical([
    ['speaker-0', 0, soleTurnSec], // fully inside the expert-only sole window [0,80)s
    ['speaker-0', 90, 95], // padding, OUTSIDE the sole window — keeps the total above 5s/5%
    ['speaker-1', 150, 160], // spoken while both parties are present — never sole either side
    // The client (joining at 200s, never leaving) needs its OWN coverage of at least half the
    // pair's speech; the expert is continuous, so this turn can never become client sole
    // evidence (the expert's dilation always swallows it) — it only feeds the coverage gate.
    ['speaker-1', 250, 300],
  ]);
  const input = buildInput(canonical, [
    presenceRow('expert', { userId: EXPERT_USER_ID }, -100, null),
    presenceRow('client', { userId: CLIENT_USER_ID }, 200, null),
  ]);
  return derivePartyHint(input);
}

/** Builds the shared "margin pin" scenario: an utterance ending `gapSec` before the client joins. */
function buildMarginPinResult(gapSec: number): ReturnType<typeof derivePartyHint> {
  const end = 300 - gapSec;
  const canonical = diarizedCanonical([
    ['speaker-0', end - 10, end],
    ['speaker-1', 400, 410],
  ]);
  const input = buildInput(canonical, [
    presenceRow('expert', { userId: EXPERT_USER_ID }, -1000, null),
    presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
  ]);
  return derivePartyHint(input);
}

describe('derivePartyHint — a zero-length presence blip is not "the one present" (BAL-134 R10 clamp)', () => {
  // The R10 clamp (and `closeAllOpen`'s GREATEST) can turn a party who was briefly in the room
  // into a presence row with joinedAt === leftAt, pinned to `scheduled_start`. That instant is
  // usually still inside the recorded segment, so an inclusive strict-window check would wrongly
  // treat it as "the one expert/client present" — even though nobody was actually THERE for any
  // positive span of the segment.
  // The speech is shifted later than the blip so the positive-control test's real presence
  // window ([320,∞)) can cover it (the party speech coverage gate); the first three tests below
  // fail at the population/identity-count gate, before that coverage gate is ever reached, so
  // this shift does not affect their reason at all.
  const blipCanonical = diarizedCanonical([
    ['speaker-0', 400, 460],
    ['speaker-1', 460, 600],
  ]);

  it('an expert blip clamped to a single instant is not "the one expert present"', () => {
    const input = buildInput(blipCanonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 300, 300),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'none',
      reason: 'expert_identity_count_not_one',
    });
  });

  it('the same blip exactly at segStart (boundary) is still not positive-length presence', () => {
    const input = buildInput(blipCanonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 0),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'none',
      reason: 'expert_identity_count_not_one',
    });
  });

  it('the mirror for the client side: a client blip is not "the one client present"', () => {
    const input = buildInput(blipCanonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 300, 300),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'none',
      reason: 'client_identity_count_not_one',
    });
  });

  it('positive control: a blip followed by a real return positively overlaps S and still emits', () => {
    const input = buildInput(blipCanonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 300, 300),
      presenceRow('expert', { userId: EXPERT_USER_ID }, 320, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'roster_only',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 30 },
          { ref: 'speaker-1', talkTimePercent: 70 },
        ],
      },
    });
  });
});

describe('derivePartyHint — presence margin (PRESENCE_SKEW_MARGIN_MS)', () => {
  it('an observer who left 90s before the segment start blocks the hint (inside the expanded window)', () => {
    const base = rosterOnlyInput();
    const result = derivePartyHint({
      ...base,
      presence: [
        ...base.presence,
        presenceRow('observer', { userId: OBSERVER_USER_ID }, -1000, -90),
      ],
    });
    expect(result).toEqual({ kind: 'none', reason: 'presence_observer_present' });
  });

  it('an observer who left 150s before the segment start does not block the hint (outside the expanded window)', () => {
    const base = rosterOnlyInput();
    const result = derivePartyHint({
      ...base,
      presence: [
        ...base.presence,
        presenceRow('observer', { userId: OBSERVER_USER_ID }, -1000, -150),
      ],
    });
    expect(result.kind).toBe('hint');
  });
});

// ── Complement mapping + same-voice conflict ──────────────────────────────────────────────────
//
// Every emit test above has the expert-side leader at `refs[0]`. That leaves two branches of
// `decideTiming` unexercised: `expertLeader.index === 1` (the "speaks first = expert" mutant
// hard-codes `expertRef = refs[0]` and would still pass every test above), and
// `clientLeader.index === 0` (the complement arm on the OTHER side). Both are covered here,
// plus a second same-voice-in-both-windows conflict (T4) distinct from the existing one in
// `SKIP_SCENARIOS`.
describe('derivePartyHint — complement mapping + same-voice conflict', () => {
  it('T3: the client speaks first (refs[0]); the expert (refs[1]) is the only sole leader', () => {
    // Client (speaker-0, first appearance) speaks briefly while both are present. The client
    // leaves at 600s; the expert (speaker-1, never leaves) then speaks alone at 750-850s —
    // sole evidence for the EXPERT side, whose leading voice is refs[1], not refs[0].
    //
    // The [200,260] turn is a client-coverage-only addition, placed inside the client's OWN
    // window [0,600]s (client's coverage would otherwise be 60_000/160_000 = 37.5%, since
    // speaker-1's turn at 750-850s falls after the client has already left). It is well outside
    // the expert-only sole window ([720,900]s), so the pinned evidence (100_000) is unaffected;
    // percentages are recomputed for the added speaker-0 speech.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 60],
      ['speaker-1', 750, 850],
      ['speaker-0', 200, 260],
    ]);
    const input = buildInput(canonical, [
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, 600),
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 55 },
          { ref: 'speaker-1', talkTimePercent: 45 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-1', soleSpeechMs: 100_000 }],
        expertRef: 'speaker-1',
        clientRef: 'speaker-0',
      },
    });
  });

  it('a client-side leader at refs[0], no expert leader (the complement arm that goes unexercised when the client is always refs[1])', () => {
    // Client (speaker-0, first appearance) joins early and speaks alone before the expert
    // joins — the SAME shape as `expertWaitingInput`, with the two sides swapped. The client's
    // leading voice is refs[0], so the complement (`clientLeader.index === 0`) resolves
    // expertRef to refs[1] — the branch that never runs when the client is always refs[1].
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 40],
      ['speaker-1', 360, 400],
    ]);
    const input = buildInput(canonical, [
      presenceRow('client', { userId: CLIENT_USER_ID }, -60, null),
      presenceRow('expert', { userId: EXPERT_USER_ID }, 300, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 43 },
          { ref: 'speaker-1', talkTimePercent: 57 },
        ],
        evidence: [{ side: 'client', speakerRef: 'speaker-0', soleSpeechMs: 30_000 }],
        expertRef: 'speaker-1',
        clientRef: 'speaker-0',
      },
    });
  });

  it('T4: the SAME voice dominates both the expert-only and client-only windows → conflict, never a fallback', () => {
    // Expert [-600,400], client [200,∞) (review's T4 fixture). speaker-0 speaks both early
    // (sole to the expert-only window) and late (sole to the client-only window) — the same
    // voice cannot be BOTH sides, so the whole hint is dropped rather than picking one.
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 40],
      ['speaker-1', 250, 280],
      ['speaker-0', 800, 850],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 400),
      presenceRow('client', { userId: CLIENT_USER_ID }, 200, null),
    ]);
    expect(derivePartyHint(input)).toEqual({ kind: 'none', reason: 'presence_timing_conflict' });
  });
});

// ── mergeSpans / subtractSpans branches ───────────────────────────────────────────────────────
//
// Every scenario above gives each identity a single presence interval, and no cut ever starts
// after an own span ends — so `mergeSpans`' fold and `subtractSpans`' `break` never ran. T1, T2
// and T5 below are traced fixtures, verified by running the real `derivePartyHint`, not
// hand-derived.
describe('derivePartyHint — interval-math branches (mergeSpans fold, subtractSpans break/continue)', () => {
  it('T1: drop and rejoin — the DILATED cuts merge, and the UNMERGED own spans stay two disjoint pieces', () => {
    // Expert drops and rejoins: [-600,100] and [150,∞). Client: [200,∞). The two DILATED expert
    // cuts ([-720,220] and [30,∞)) merge into one, closing off any client sole evidence. The
    // expert's own (undilated) spans do NOT merge — [-600,100] and [150,∞) leave a genuine
    // 50s gap — so `own(expert)` stays two disjoint clipped pieces, [0,100] and [150,segEnd];
    // subtracting the (single) client cut [80,∞) trims the FIRST piece to [0,80] and removes
    // the second piece entirely (150 already lies inside the cut).
    //
    // Speaker-1's turn was widened from 50s to 70s (talk-time percentages recomputed
    // accordingly) so the client's own span ([200,900]s) covers enough of the pair's total
    // speech (70_000 / 130_000 = 53.8%) to clear the 50% coverage floor — the client's own span
    // never overlaps speaker-0's turn at all, so its coverage comes entirely from speaker-1's
    // turn, and 50s of it alone was only 45.5%. The sole-evidence math this test pins
    // (speaker-0's 60_000ms) is unaffected, since speaker-1's turn is fully outside the
    // expert-only sole region either way.
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 70],
      ['speaker-1', 500, 570],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 100),
      presenceRow('expert', { userId: EXPERT_USER_ID }, 150, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 200, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 46 },
          { ref: 'speaker-1', talkTimePercent: 54 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 60_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('T2: a gap between leave and join — the break still guards the expert span, and gap speech still contributes 0', () => {
    // Expert [-600,300] (leaves, no rejoin); client [100,250] (a brief early visit) and [520,∞)
    // (rejoins later, same identity). Expert's own [0,300] against the client's TWO dilated cuts
    // ([-20,370] from the early visit, [400,∞) from the rejoin) hits the `break` on the second
    // cut (it starts after the span ends), so [0,300] survives NOT truncated by it — the first
    // cut still trims the span from the front. Client's own [520,900] against the expert's
    // dilated cut [-720,420] hits the `continue` (the cut ends before the span starts), giving
    // the FULL [520,900]. speaker-1's [375,395] falls in the UNATTENDED gap (the expert has
    // already left, the client has not yet rejoined) and contributes 0 sole evidence either way
    // — this is what a `break`-removing mutant gets wrong: without it, the expert's sole region
    // would wrongly extend into [370,400] and swallow this gap turn.
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 90],
      ['speaker-0', 100, 250],
      ['speaker-1', 375, 395],
      ['speaker-1', 600, 700],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 300),
      presenceRow('client', { userId: CLIENT_USER_ID }, 100, 250),
      presenceRow('client', { userId: CLIENT_USER_ID }, 520, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 66 },
          { ref: 'speaker-1', talkTimePercent: 34 },
        ],
        evidence: [{ side: 'client', speakerRef: 'speaker-1', soleSpeechMs: 100_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('T5: touching intervals merge — a turn straddling the touch point counts in full', () => {
    // Expert [-600,100] and [100,∞) TOUCH exactly at 100s, so `mergeSpans` folds them into one
    // continuous own span. A turn [90,110] straddling that touch point then counts in full
    // (20s) as sole evidence — without the fold, it would be split across two separate pieces
    // and neither would fully contain it, so it would count as 0.
    const canonical = diarizedCanonical([
      ['speaker-0', 90, 110],
      ['speaker-1', 500, 550],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 100),
      presenceRow('expert', { userId: EXPERT_USER_ID }, 100, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 29 },
          { ref: 'speaker-1', talkTimePercent: 71 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 20_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });
});

describe('derivePartyHint — per-segment windowing', () => {
  const turns = [
    ['speaker-0', 0, 60],
    ['speaker-1', 60, 120],
    ['speaker-0', 120, 180],
    ['speaker-1', 180, 300],
  ] as const;
  const canonical = diarizedCanonical(turns);
  const cleanedText = renderTranscriptText(canonical);

  function segmentInput(overrides: Partial<DerivePartyHintInput>): DerivePartyHintInput {
    return {
      vendor: 'daily_deepgram',
      canonical,
      cleanedText,
      meetingId: MEETING_ID,
      recording: recordingSegment(),
      presence: [],
      ...overrides,
    };
  }

  it('segment 1 (0-15min) resolves against C1, segment 2 (40-55min) resolves against C2', () => {
    const presence: readonly PartyHintPresenceInterval[] = [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 0, 1500), // C1 — gone well before segment 2
      presenceRow('client', { meetingGuestId: CLIENT_GUEST_ID }, 2350, null), // C2 — segment 2 only
    ];

    const segment1 = derivePartyHint(
      segmentInput({ recording: recordingSegment({ startedAt: SEGMENT_START }), presence })
    );
    expect(segment1.kind).toBe('hint');

    const segment2 = derivePartyHint(
      segmentInput({ recording: recordingSegment({ startedAt: at(2400) }), presence })
    );
    expect(segment2.kind).toBe('hint');
  });

  it('without C2, segment 2 sees no client identity at all (the window is per-segment, not meeting-wide)', () => {
    const presence: readonly PartyHintPresenceInterval[] = [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 0, 1500),
    ];
    const segment2 = derivePartyHint(
      segmentInput({ recording: recordingSegment({ startedAt: at(2400) }), presence })
    );
    expect(segment2).toEqual({ kind: 'none', reason: 'client_identity_count_not_one' });
  });

  it('an observer present only during segment 2 leaves segment 1 a hint but blocks segment 2', () => {
    const presence: readonly PartyHintPresenceInterval[] = [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 0, 1500),
      presenceRow('client', { meetingGuestId: CLIENT_GUEST_ID }, 2350, null),
      presenceRow('observer', { userId: OBSERVER_USER_ID }, 2350, null),
    ];

    const segment1 = derivePartyHint(
      segmentInput({ recording: recordingSegment({ startedAt: SEGMENT_START }), presence })
    );
    expect(segment1.kind).toBe('hint');

    const segment2 = derivePartyHint(
      segmentInput({ recording: recordingSegment({ startedAt: at(2400) }), presence })
    );
    expect(segment2).toEqual({ kind: 'none', reason: 'presence_observer_present' });
  });
});

describe('derivePartyHint — cleaned_labels_not_preserved', () => {
  it('a partial relabel on one line is rejected', () => {
    expect(
      derivePartyHint(rosterOnlyInput({ cleanedText: 'Expert: hi\nspeaker-1: hello' }))
    ).toEqual({ kind: 'none', reason: 'cleaned_labels_not_preserved' });
  });

  it('a wholesale swap of the opening turns is rejected — the mutation this test pins', () => {
    // The canonical order is [speaker-0, speaker-1]; presenting speaker-1's line FIRST is a
    // swap, not a relabel — every ref is still present, but out of first-appearance order.
    expect(
      derivePartyHint(
        rosterOnlyInput({ cleanedText: 'speaker-1: swapped first\nspeaker-0: swapped second' })
      )
    ).toEqual({ kind: 'none', reason: 'cleaned_labels_not_preserved' });
  });

  it('blank lines interleaved still emit (positive control)', () => {
    const base = rosterOnlyInput();
    const withBlankLines = renderTranscriptText(base.canonical).split('\n').join('\n\n');
    const result = derivePartyHint({ ...base, cleanedText: withBlankLines });
    expect(result.kind).toBe('hint');
  });
});

// ── Skip reasons, table-driven (a Record makes a missing reason a compile error) ──────────

type DeriveSkipReason = Exclude<
  PartyHintSkipReason,
  'capture_id_unrecognised' | 'recording_not_found'
>;

interface SkipVariant {
  readonly label: string;
  readonly build: () => DerivePartyHintInput;
}

/**
 * Arrays of builders, not one-per-reason, so every required boundary/near-miss variant has
 * somewhere to live without losing the "every reason has at least one scenario" compile-time
 * guarantee the `Record` gives.
 */
const SKIP_SCENARIOS: Record<DeriveSkipReason, readonly SkipVariant[]> = {
  vendor_not_daily_deepgram: [
    { label: 'input.vendor mismatch', build: () => rosterOnlyInput({ vendor: 'recall' }) },
    {
      label: 'canonical.vendor mismatch (input vendor ok)',
      build: () =>
        rosterOnlyInput({
          canonical: { ...diarizedCanonical([['speaker-0', 0, 10]]), vendor: 'recall' },
        }),
    },
  ],
  speakers_not_diarized: [
    {
      label: 'authenticated canonical (non-null userId)',
      build: () => rosterOnlyInput({ canonical: normalizeDailyDeepgram(dailyMultiSpeaker) }),
    },
    {
      label: 'empty speakers array',
      build: () => rosterOnlyInput({ canonical: normalizeDailyDeepgram(dailyEmpty) }),
    },
    {
      label: 'a diarized speaker with a non-null displayName',
      build: () =>
        rosterOnlyInput({
          canonical: {
            schemaVersion: 1,
            vendor: 'daily_deepgram',
            language: 'en',
            fillerWords: true,
            speakers: [
              { ref: 'speaker-0', displayName: 'Dana', userId: null, source: 'diarized' },
              { ref: 'speaker-1', displayName: null, userId: null, source: 'diarized' },
            ],
            segments: [
              {
                index: 0,
                speakerRef: 'speaker-0',
                startMs: 0,
                endMs: 10_000,
                text: 'hi',
                confidence: 1,
              },
              {
                index: 1,
                speakerRef: 'speaker-1',
                startMs: 10_000,
                endMs: 20_000,
                text: 'hey',
                confidence: 1,
              },
            ],
            durationMs: 20_000,
          } satisfies CanonicalTranscript,
        }),
    },
  ],
  speaker_ref_unrecognised: [
    {
      label: 'a plain name',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['Dana', 0, 10],
            ['speaker-1', 10, 20],
          ]),
        }),
    },
    ...(
      [
        ['speaker-1\nx', 'trailing newline plus more text'],
        ['speaker-12345', 'too many digits (5, pattern allows 1-4)'],
        ['speaker-0: x', 'trailing colon-and-text'],
        ['Speaker-0', 'capitalised (case-sensitive pattern)'],
        ['speaker-', 'no digits at all'],
      ] as const
    ).map(([ref, label]) => ({
      label: `near-miss: ${label} ("${ref.replace('\n', '\\n')}")`,
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            [ref, 0, 10],
            ['speaker-1', 10, 20],
          ]),
        }),
    })),
  ],
  speaker_count_not_two: [
    {
      label: 'one voice',
      build: () => rosterOnlyInput({ canonical: diarizedCanonical([['speaker-0', 0, 10]]) }),
    },
    {
      label: 'three voices',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['speaker-0', 0, 10],
            ['speaker-1', 10, 20],
            ['speaker-2', 20, 30],
          ]),
        }),
    },
  ],
  unknown_speech_too_high: [
    {
      label: '50% unknown (well over)',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['speaker-0', 0, 100],
            ['speaker-1', 100, 200],
            [null, 200, 400],
          ]),
        }),
    },
    {
      label: '6% unknown (just over the 5% boundary)',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['speaker-0', 0, 23.5],
            ['speaker-1', 23.5, 47],
            [null, 47, 50],
          ]),
        }),
    },
  ],
  speaker_share_too_low: [
    {
      label: '1s / 100s (fails both the ms and the share arm)',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['speaker-0', 0, 100],
            ['speaker-1', 100, 101],
          ]),
        }),
    },
    {
      label: '4% share with >=5s speech (isolates the share arm)',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['speaker-0', 0, 5],
            ['speaker-1', 5, 125],
          ]),
        }),
    },
    {
      label: '<5s speech with >=5% share (isolates the ms-floor arm)',
      build: () =>
        rosterOnlyInput({
          canonical: diarizedCanonical([
            ['speaker-0', 0, 4],
            ['speaker-1', 4, 80],
          ]),
        }),
    },
  ],
  cleaned_text_contains_hint_tag: [
    {
      label: 'an opening tag inside a speaker-0 line',
      build: () =>
        rosterOnlyInput({ cleanedText: 'speaker-0: hi <speaker_party_hint>\nspeaker-1: hello' }),
    },
    {
      label: 'a closing tag',
      build: () =>
        rosterOnlyInput({ cleanedText: 'speaker-0: hi\nspeaker-1: bye </speaker_party_hint>' }),
    },
    {
      label: 'an uppercase-cased variant',
      build: () =>
        rosterOnlyInput({ cleanedText: 'speaker-0: HI SPEAKER_PARTY_HINT\nspeaker-1: hello' }),
    },
  ],
  cleaned_labels_not_preserved: [
    {
      label: 'a partial relabel',
      build: () => rosterOnlyInput({ cleanedText: 'Expert: hi\nspeaker-1: hello' }),
    },
    {
      // Every line here carries a KNOWN ref (`speaker-0`), so this never reaches
      // `label === undefined` — it is rejected only by the final `seen.length === 2` check,
      // because `refB` (`speaker-1`) never appears at all. Without that check, cleanup folding
      // every one of the client's lines under the expert's label would go undetected, and the
      // hint would then name a side for speech that was never actually attributed to it.
      label: 'a named ref absent from the cleaned text (all lines known)',
      build: () => rosterOnlyInput({ cleanedText: 'speaker-0: a\nspeaker-0: b' }),
    },
  ],
  recording_meeting_mismatch: [
    {
      label: 'a different meeting id',
      build: () =>
        rosterOnlyInput({ recording: recordingSegment({ meetingId: 'different-meeting-id' }) }),
    },
  ],
  recording_start_unknown: [
    {
      label: 'startedAt: null',
      build: () => rosterOnlyInput({ recording: recordingSegment({ startedAt: null }) }),
    },
    {
      label: 'startedAt: new Date(NaN)',
      build: () => rosterOnlyInput({ recording: recordingSegment({ startedAt: new Date(NaN) }) }),
    },
  ],
  presence_interval_invalid: [
    {
      label: 'a NaN joinedAt',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            {
              party: 'client',
              userId: CLIENT_USER_ID,
              meetingGuestId: null,
              joinedAt: new Date(NaN),
              leftAt: null,
            },
          ],
        }),
    },
    {
      label: 'a reversed interval (leftAt before joinedAt)',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('client', { userId: CLIENT_USER_ID }, 100, 50),
          ],
        }),
    },
  ],
  presence_identity_missing: [
    {
      label: 'an overlapping row with no identity',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
            {
              party: 'observer',
              userId: null,
              meetingGuestId: null,
              joinedAt: at(0),
              leftAt: null,
            },
          ],
        }),
    },
  ],
  presence_observer_present: [
    {
      label: 'an overlapping observer with a valid identity',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
            presenceRow('observer', { userId: OBSERVER_USER_ID }, -600, null),
          ],
        }),
    },
  ],
  presence_identity_on_both_sides: [
    {
      label: 'the same identity as both expert and client',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('client', { userId: EXPERT_USER_ID }, -600, null),
          ],
        }),
    },
  ],
  expert_identity_count_not_one: [
    {
      label: 'two distinct expert identities',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('expert', { userId: OBSERVER_USER_ID }, -600, null),
            presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
          ],
        }),
    },
    {
      label: 'zero experts',
      build: () =>
        rosterOnlyInput({
          presence: [presenceRow('client', { userId: CLIENT_USER_ID }, -600, null)],
        }),
    },
  ],
  client_identity_count_not_one: [
    {
      label: 'two distinct client identities (different text)',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
            presenceRow('client', { meetingGuestId: CLIENT_GUEST_ID }, -600, null),
          ],
        }),
    },
    {
      label: 'a user id and a guest id with the SAME text (namespacing pin)',
      build: () =>
        rosterOnlyInput({
          presence: [
            presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
            presenceRow('client', { userId: SAME_TEXT_ID }, -600, null),
            presenceRow('client', { meetingGuestId: SAME_TEXT_ID }, -600, null),
          ],
        }),
    },
  ],
  expert_presence_too_brief: [
    {
      label: 'a 1-second expert presence row does not prove attendance',
      build: () =>
        buildInput(COVERAGE_GATE_CANONICAL, [
          presenceRow('expert', { userId: EXPERT_USER_ID }, 300, 301),
          presenceRow('client', { userId: CLIENT_USER_ID }, 360, null),
        ]),
    },
    {
      label: 'a 30-second expert presence row is still too brief relative to 440s of speech',
      build: () =>
        buildInput(COVERAGE_GATE_CANONICAL, [
          presenceRow('expert', { userId: EXPERT_USER_ID }, 300, 330),
          presenceRow('client', { userId: CLIENT_USER_ID }, 360, null),
        ]),
    },
    {
      label: 'an expert present from the start who drops 30s in and never returns',
      build: () =>
        buildInput(COVERAGE_GATE_CANONICAL, [
          presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 30),
          presenceRow('client', { userId: CLIENT_USER_ID }, 360, null),
        ]),
    },
  ],
  client_presence_too_brief: [
    {
      label: 'the client mirror: a brief client presence row is too brief for its own speech',
      build: () =>
        buildInput(COVERAGE_GATE_CANONICAL, [
          presenceRow('expert', { userId: EXPERT_USER_ID }, 360, null),
          presenceRow('client', { userId: CLIENT_USER_ID }, 300, 301),
        ]),
    },
  ],
  presence_timing_conflict: [
    {
      label: 'both voices heard in the same expert-only window',
      build: () => {
        // The [400,470] turn is a client-coverage-only addition: it sits well past the
        // expert-only sole region ([0,180]s, since the client's dilated cut starts at 180s) and
        // well within the client's own span, so it clears the coverage floor for the client
        // without touching the conflict this scenario tests.
        const canonical = diarizedCanonical([
          ['speaker-0', 10, 40],
          ['speaker-1', 50, 80],
          ['speaker-1', 400, 470],
        ]);
        return buildInput(canonical, [
          presenceRow('expert', { userId: EXPERT_USER_ID }, -60, null),
          presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
        ]);
      },
    },
    {
      label:
        'a non-top voice at 3s+ inside a one-party window is a conflict even above 90% dominance',
      build: () => buildSingleWindowContestInput(60, 5),
    },
    {
      label: '89% dominance with a sub-3s non-top voice is still a conflict (17.8s vs 2.2s)',
      build: () => buildSingleWindowContestInput(17.8, 2.2),
    },
  ],
};

describe('derivePartyHint — skip reasons (table-driven)', () => {
  for (const [reason, variants] of Object.entries(SKIP_SCENARIOS)) {
    it.each(variants.map(({ label, build }) => [label, build] as const))(
      `${reason}: %s`,
      (_label, build) => {
        expect(derivePartyHint(build())).toEqual({ kind: 'none', reason });
      }
    );
  }
});

describe('derivePartyHint — positive boundary controls', () => {
  it('exactly 5.0% unknown speech still emits (the boundary is strict >, not >=)', () => {
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 47.5],
      ['speaker-1', 47.5, 95],
      [null, 95, 100],
    ]);
    const result = derivePartyHint(
      buildInput(canonical, [
        presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
        presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
      ])
    );
    expect(result.kind).toBe('hint');
  });

  it('exactly 90% dominance gives a leader (the boundary is strict <, not <=)', () => {
    // Re-pinned at 18s vs 2s: the non-top voice must stay UNDER MIN_SOLE_SPEECH_MS (3s), or the
    // non-top-voice conflict floor fires first regardless of dominance — see the
    // single-party-window describe block below for that case. 18/20 = 90% exactly, still a
    // leader.
    const input = buildSingleWindowContestInput(18, 2);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 15 },
          { ref: 'speaker-1', talkTimePercent: 85 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 18_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('89% dominance (just under the boundary) is a conflict, not a leader', () => {
    // Re-pinned at 17.8s vs 2.2s: the non-top voice stays under 3s, isolating the DOMINANCE
    // boundary from the separate non-top-floor conflict rule.
    const input = buildSingleWindowContestInput(17.8, 2.2);
    expect(derivePartyHint(input)).toEqual({ kind: 'none', reason: 'presence_timing_conflict' });
  });

  it('SOLE_SPEECH_DOMINANCE is the constant the two boundary tests above pin', () => {
    expect(SOLE_SPEECH_DOMINANCE).toBe(0.9);
  });

  it('a leader whose OWN sole speech is exactly 2900ms (96.7% dominance, 3000ms window total) yields NO timing evidence', () => {
    // The 3s floor applies to the LEADER's own evidence, not just the window total: 2900ms +
    // 100ms = a 3000ms total that clears MIN_SOLE_SPEECH_MS, and 2900/3000 clears the 90%
    // dominance floor, but the leader's own 2900ms does not clear the 3s floor by itself.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 2.9], // 2900ms — inside the expert-only sole window [0,80)s
      ['speaker-0', 90, 95], // padding, outside the sole window — clears the overall share floor
      ['speaker-1', 3, 3.1], // 100ms — competing evidence, inside the SAME sole window
      ['speaker-1', 150, 160], // padding, outside the sole window
      // The client (joining at 200s) needs its OWN coverage of at least half the pair's speech;
      // expert is continuous so this turn (safely inside the client's own span) cannot become
      // client sole evidence (expert's dilation still covers it) — it only feeds coverage.
      ['speaker-1', 300, 320],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -100, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 200, null),
    ]);
    const result = derivePartyHint(input);
    expect(result.kind).toBe('hint');
    if (result.kind === 'hint') {
      expect(result.hint.basis).toBe('roster_only');
    }
  });
});

describe('derivePartyHint — party speech coverage gate', () => {
  it('coverage exactly 50% still emits (the boundary is strict <, not <=)', () => {
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 50],
      ['speaker-1', 50, 100],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 50),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input).kind).toBe('hint');
  });

  it('coverage just under 50% skips as too brief', () => {
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 50],
      ['speaker-1', 50, 100],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 49.999),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'none',
      reason: 'expert_presence_too_brief',
    });
  });

  it("a segment straddling the edge of a party's own presence span counts only its overlapping part", () => {
    // Full credit for speaker-0 (45_000ms, fully inside [0,55_000]) + PARTIAL credit for the
    // straddling speaker-1 segment (only its [50_000,55_000] slice, 5_000ms) = 50_000ms of
    // 95_000ms total (52.6%), clearing the 50% floor. All-or-nothing credit (excluding the
    // straddling segment entirely) would give only 45_000/95_000 = 47.4%, which would WRONGLY
    // skip — this test pins the partial-credit behaviour, not just any passing numbers.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 45],
      ['speaker-1', 50, 100],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 55),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input).kind).toBe('hint');
  });

  it('unknown speech is excluded from the coverage denominator and numerator alike', () => {
    // Total PAIR speech is speaker-0's 47s + speaker-1's 53s = 100s; the 4s of `unknown` speech
    // in between must count toward NEITHER. The expert's own span [0,51]s covers all of
    // speaker-0's 47s but none of speaker-1's 53s: 47/100 = 47% — under the floor. If `unknown`
    // speech counted, the denominator would grow (or the expert's covered unknown slice would
    // count), changing the ratio and wrongly emitting.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 47],
      [null, 47, 51],
      ['speaker-1', 51, 104],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 51),
      presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'none',
      reason: 'expert_presence_too_brief',
    });
  });

  it('overlapping presence rows for one identity are merged for coverage, not double-counted', () => {
    // Two OVERLAPPING expert rows ([0,300] and [100,499]) union to a single [0,499]s span, not
    // 300+399=699s of double-counted coverage. Against 1000s of pair speech, the union gives
    // 499/1000 = 49.9% — under the floor. Double-counting the overlap would wrongly reach 69.9%.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 100],
      ['speaker-1', 100, 400],
      ['speaker-0', 400, 1000],
    ]);
    const input = buildInput(
      canonical,
      [
        presenceRow('expert', { userId: EXPERT_USER_ID }, 0, 300),
        presenceRow('expert', { userId: EXPERT_USER_ID }, 100, 499),
        presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
      ],
      { recording: recordingSegment({ durationSeconds: 1000 }) }
    );
    expect(derivePartyHint(input)).toEqual({
      kind: 'none',
      reason: 'expert_presence_too_brief',
    });
  });
});

describe('derivePartyHint — single-party-window contradiction and weak same-voice signals', () => {
  it('spill tolerance: a non-top voice under 3s does not trip the new conflict floor (60s vs 2.9s is still a leader)', () => {
    const input = buildSingleWindowContestInput(60, 2.9);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 37 },
          { ref: 'speaker-1', talkTimePercent: 63 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 60_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it("a weak same-voice signal still blocks a contradictory mapping (doesn't fall back to a mapping)", () => {
    // Expert (-100,300), client (200,∞). speaker-0 [0,2.9] + speaker-1 [3,3.1] inside the
    // expert-only window (a WEAK signal for speaker-0); speaker-1 [210,230] while both are
    // present (coverage only); speaker-0 [600,620] inside the client-only window (a REAL leader
    // for speaker-0 there — the SAME voice the expert side already weakly favours). The
    // client-only turn is kept to 20s (rather than a larger, more obviously client-dominant
    // span) so the party speech coverage gate clears for the expert (23_000 / 43_000 = 53.5%)
    // without changing the phenomenon under test: a weak signal at the SAME index as a real
    // leader on the other side must still conflict, not silently drop out and let the real
    // leader map alone.
    const input = buildContraryVoiceInput([
      ['speaker-0', 0, 2.9],
      ['speaker-1', 3, 3.1],
      ['speaker-1', 210, 230],
      ['speaker-0', 600, 620],
    ]);
    expect(derivePartyHint(input)).toEqual({ kind: 'none', reason: 'presence_timing_conflict' });
  });

  it.each([
    ['a lone 1s signal, no contrary noise', []],
    ['plus 1.001s of contrary noise in the same window', [['speaker-1', 2, 3.001]]],
    ['plus 2s of contrary noise in the same window', [['speaker-1', 2, 4]]],
  ] as const)(
    'two sub-3s voices each heard alone for >=1s in a one-party window contradict a mapping, even with no real leader on either side: %s',
    (_label, extraTurns) => {
      // Expert (-100,300), client (200,∞). speaker-0 speaks 1s alone where attendance shows only
      // the expert present; the extra turn (if any) adds a second voice to that SAME window.
      // speaker-0 also speaks 20s alone where attendance shows only the client present (a real
      // leader there). Even when neither voice in the expert-only window individually clears
      // MIN_SOLE_SPEECH_MS (so neither is a real leader), two voices each heard alone for at
      // least MIN_WEAK_SOLE_SPEECH_MS in a one-party window is itself a contradiction — the
      // window cannot legitimately contain two voices with nobody else recorded present.
      const input = buildContraryVoiceInput([
        ['speaker-0', 0, 1],
        ...extraTurns,
        ['speaker-1', 210, 230],
        ['speaker-0', 600, 620],
      ]);
      expect(derivePartyHint(input)).toEqual({ kind: 'none', reason: 'presence_timing_conflict' });
    }
  );

  it('sub-1s noise stays a leader signal: a 2.5s/0.4s split in a one-party window still MAPS (pins the total>=3s guard on the dominance check)', () => {
    // Expert (-100,300), client (200,∞). speaker-0 speaks 2.5s and speaker-1 speaks 0.4s where
    // attendance shows only the expert present — a 2.9s window total, under MIN_SOLE_SPEECH_MS,
    // so the dominance check must NOT fire even though 2500/2900 = 86.2% is under
    // SOLE_SPEECH_DOMINANCE; speaker-1's 0.4s also stays under MIN_WEAK_SOLE_SPEECH_MS, so it
    // does not itself contradict speaker-0. speaker-0's [100,105] turn is padding (while both
    // parties are recorded present) so its OVERALL total clears MIN_SPEAKER_SPEECH_MS; it sits
    // outside both sole regions. speaker-1 speaks 20s alone where attendance shows only the
    // client present — a real leader at a DIFFERENT index than the expert's weak speaker-0
    // signal, so the two are consistent and the client leader maps unopposed.
    const input = buildContraryVoiceInput([
      ['speaker-0', 0, 2.5],
      ['speaker-1', 2.5, 2.9],
      ['speaker-0', 100, 105],
      ['speaker-1', 210, 230],
      ['speaker-1', 600, 620],
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 16 },
          { ref: 'speaker-1', talkTimePercent: 84 },
        ],
        evidence: [{ side: 'client', speakerRef: 'speaker-1', soleSpeechMs: 20_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  // Expert (-100,300), client (200,∞). speaker-0 speaks 2.9s where attendance shows only the
  // expert present, and 20s where attendance shows only the client present — the SAME voice on
  // both sides. Before the monotone fix, a lone sub-3s signal classified as `none` (not `weak`),
  // so this silently mapped from the client leader alone (`clientRef: speaker-0`, `expertRef:
  // speaker-1`) even though the expert-side evidence directly contradicts it. The second variant
  // adds a 0.1s spill from the other voice, proving the conflict comes from the monotone
  // sole-speech rule itself, not merely from a two-voice spill.
  it.each([
    ['a lone 2.9s signal, no spill', []],
    ['the same, plus a 0.1s spill from the other voice', [['speaker-1', 3, 3.1]]],
  ] as const)(
    'a lone sub-3s same-voice contrary signal still conflicts with a real leader at the same index (monotone): %s',
    (_label, extraTurns) => {
      const input = buildContraryVoiceInput([
        ['speaker-0', 0, 2.9],
        ...extraTurns,
        ['speaker-1', 210, 230],
        ['speaker-0', 600, 620],
      ]);
      expect(derivePartyHint(input)).toEqual({ kind: 'none', reason: 'presence_timing_conflict' });
    }
  );

  it('floor boundary: a 999ms same-voice contrary signal still MAPS; at 1000ms it conflicts', () => {
    // Expert (-100,300), client (200,∞). speaker-0 speaks `topMs` where attendance shows only
    // the expert present (an isolated, single-voice signal — no competing speaker-1 there), and
    // 20s where attendance shows only the client present (a real leader). speaker-1's own [250,270]
    // turn sits in the window where BOTH are recorded present (coverage only; excluded from both
    // sole regions) so the precheck's speaker-count/share gates pass and coverage clears for
    // both sides without touching either sole region.
    function buildFloorInput(topMs: number): DerivePartyHintInput {
      const topSec = topMs / 1000;
      return buildContraryVoiceInput([
        ['speaker-0', 0, topSec],
        ['speaker-1', 250, 270],
        ['speaker-0', 600, 620],
      ]);
    }

    expect(derivePartyHint(buildFloorInput(999))).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 51 },
          { ref: 'speaker-1', talkTimePercent: 49 },
        ],
        evidence: [{ side: 'client', speakerRef: 'speaker-0', soleSpeechMs: 20_000 }],
        expertRef: 'speaker-1',
        clientRef: 'speaker-0',
      },
    });

    expect(derivePartyHint(buildFloorInput(1000))).toEqual({
      kind: 'none',
      reason: 'presence_timing_conflict',
    });
  });

  it('a weak signal with a DIFFERENT index than a real leader on the other side still maps (from the real leader alone)', () => {
    // The [250,253] turn is padding: without it speaker-0's total (2_900ms) falls below
    // MIN_SPEAKER_SPEECH_MS, tripping the precheck's speaker-share gate before this scenario
    // ever reaches the sideLeader logic under test. It sits between the two sole regions (after
    // the expert-only window's [0,80]s cut, before the client-only window's [420,900]s start),
    // so it lands in neither and only affects the overall talk-time split.
    const input = buildContraryVoiceInput([
      ['speaker-0', 0, 2.9],
      ['speaker-1', 3, 3.1],
      ['speaker-1', 210, 230],
      ['speaker-1', 600, 620],
      ['speaker-0', 250, 253],
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 13 },
          { ref: 'speaker-1', talkTimePercent: 87 },
        ],
        evidence: [{ side: 'client', speakerRef: 'speaker-1', soleSpeechMs: 20_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });
});

describe('derivePartyHint — invariants', () => {
  it('is pure: derivation over deep-frozen inputs does not throw and does not mutate them', () => {
    const input = expertWaitingInput();
    const snapshot = structuredClone(input);
    deepFreeze(input.canonical);
    deepFreeze(input.presence);
    deepFreeze(input.recording);

    expect(() => derivePartyHint(input)).not.toThrow();
    expect(input.canonical).toEqual(snapshot.canonical);
    expect(input.presence).toEqual(snapshot.presence);
    expect(input.recording).toEqual(snapshot.recording);
  });

  it('never leaks a participant identity into the derivation output', () => {
    const result = derivePartyHint(expertWaitingInput());
    const json = JSON.stringify(result);
    expect(json).not.toContain(EXPERT_USER_ID);
    expect(json).not.toContain(CLIENT_USER_ID);
    expect(json).not.toContain(CLIENT_GUEST_ID);
    expect(json).not.toContain(OBSERVER_USER_ID);
  });

  it('precheckPartyHint agrees with derivePartyHint on every precheck-only skip reason', () => {
    const precheckOnlyReasons: readonly DeriveSkipReason[] = [
      'vendor_not_daily_deepgram',
      'speakers_not_diarized',
      'speaker_ref_unrecognised',
      'speaker_count_not_two',
      'unknown_speech_too_high',
      'speaker_share_too_low',
      'cleaned_text_contains_hint_tag',
      'cleaned_labels_not_preserved',
    ];
    for (const reason of precheckOnlyReasons) {
      for (const { build } of SKIP_SCENARIOS[reason]) {
        const input = build();
        expect(precheckPartyHint(input)).toEqual({ kind: 'none', reason });
        expect(derivePartyHint(input)).toEqual({ kind: 'none', reason });
      }
    }
  });
});
