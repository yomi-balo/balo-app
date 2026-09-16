import { describe, it, expect } from 'vitest';
import type { CanonicalTranscript } from '@balo/db';
import {
  precheckPartyHint,
  derivePartyHint,
  MIN_SOLE_SPEECH_MS,
  SOLE_SPEECH_DOMINANCE,
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
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 40],
      ['speaker-1', 500, 540],
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
          { ref: 'speaker-0', talkTimePercent: 43 },
          { ref: 'speaker-1', talkTimePercent: 57 },
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
    const canonical = diarizedCanonical([
      ['speaker-0', 170, 185],
      ['speaker-1', 400, 410],
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
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 60],
      ['speaker-1', 750, 850],
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
          { ref: 'speaker-0', talkTimePercent: 38 },
          { ref: 'speaker-1', talkTimePercent: 62 },
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
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 70],
      ['speaker-1', 500, 550],
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
          { ref: 'speaker-0', talkTimePercent: 55 },
          { ref: 'speaker-1', talkTimePercent: 45 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 60_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('T2: a gap between leave and join — speech spoken while NOBODY was recorded present is not counted', () => {
    // Expert [-600,300] (leaves, no rejoin); client [520,∞) (joins later). Nobody is recorded
    // present from 300s to 520s. Expert's own [0,300] against the client's dilated cut
    // [400,∞) hits the `break` (the cut starts after the span ends), giving the FULL [0,300] —
    // not truncated. Client's own [520,900] against the expert's dilated cut [-720,420] hits
    // the `continue` (the cut ends before the span starts), giving the FULL [520,900].
    // speaker-1's [320,380] falls in the unattended gap and must contribute 0 either way.
    const canonical = diarizedCanonical([
      ['speaker-0', 10, 290],
      ['speaker-1', 320, 380],
      ['speaker-1', 600, 700],
    ]);
    const input = buildInput(canonical, [
      presenceRow('expert', { userId: EXPERT_USER_ID }, -600, 300),
      presenceRow('client', { userId: CLIENT_USER_ID }, 520, null),
    ]);
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 64 },
          { ref: 'speaker-1', talkTimePercent: 36 },
        ],
        evidence: [
          { side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 280_000 },
          { side: 'client', speakerRef: 'speaker-1', soleSpeechMs: 100_000 },
        ],
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
  presence_timing_conflict: [
    {
      label: 'both voices heard in the same expert-only window',
      build: () => {
        const canonical = diarizedCanonical([
          ['speaker-0', 10, 40],
          ['speaker-1', 50, 80],
        ]);
        return buildInput(canonical, [
          presenceRow('expert', { userId: EXPERT_USER_ID }, -60, null),
          presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
        ]);
      },
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
    // Both refs speak inside the SAME expert-only window: 90s vs 10s is exactly the dominance
    // threshold, which must still resolve to a leader rather than a conflict.
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 90],
      ['speaker-1', 100, 110],
    ]);
    const input = expertWaitingInput({ canonical, cleanedText: renderTranscriptText(canonical) });
    expect(derivePartyHint(input)).toEqual({
      kind: 'hint',
      hint: {
        basis: 'presence_timing',
        speakers: [
          { ref: 'speaker-0', talkTimePercent: 90 },
          { ref: 'speaker-1', talkTimePercent: 10 },
        ],
        evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 90_000 }],
        expertRef: 'speaker-0',
        clientRef: 'speaker-1',
      },
    });
  });

  it('89% dominance (just under the boundary) is a conflict, not a leader', () => {
    const canonical = diarizedCanonical([
      ['speaker-0', 0, 89],
      ['speaker-1', 100, 111],
    ]);
    const input = expertWaitingInput({ canonical, cleanedText: renderTranscriptText(canonical) });
    expect(derivePartyHint(input)).toEqual({ kind: 'none', reason: 'presence_timing_conflict' });
  });

  it('SOLE_SPEECH_DOMINANCE is the constant the two boundary tests above pin', () => {
    expect(SOLE_SPEECH_DOMINANCE).toBe(0.9);
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
