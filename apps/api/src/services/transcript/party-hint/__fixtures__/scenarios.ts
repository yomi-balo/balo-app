import type { CanonicalTranscript, MeetingParticipantParty } from '@balo/db';
import type { DailyDeepgramTranscriptPayload } from '../../normalizers/types.js';
import { normalizeDailyDeepgram } from '../../normalizers/daily-deepgram.js';
import { renderTranscriptText } from '../../llm/prompts.js';
import type { SpeakerPartyHint } from '../../llm/types.js';
import type {
  DerivePartyHintInput,
  PartyHintPresenceInterval,
  PartyHintRecordingSegment,
} from '../derive.js';

/**
 * BAL-517 — shared test-data builders for `derive.test.ts` and `resolve.test.ts`. A FIXED past
 * date is safe throughout because `derivePartyHint` never reads the wall clock.
 */
export const SEGMENT_START = new Date('2026-09-01T10:00:00.000Z');
export const MEETING_ID = '11111111-1111-4111-8111-111111111111';
export const EXPERT_USER_ID = '22222222-2222-4222-8222-222222222222';
export const CLIENT_USER_ID = '33333333-3333-4333-8333-333333333333';
export const CLIENT_GUEST_ID = '44444444-4444-4444-8444-444444444444';
export const OBSERVER_USER_ID = '55555555-5555-4555-8555-555555555555';

/** `SEGMENT_START` plus `offsetSec` seconds (may be negative — an arrival before the segment). */
export function at(offsetSec: number): Date {
  return new Date(SEGMENT_START.getTime() + offsetSec * 1000);
}

type Turn = readonly [ref: string | null, startSec: number, endSec: number];

/** A diarized Daily Batch Processor payload from `[ref, startSec, endSec]` turns. */
export function diarizedPayload(
  turns: readonly Turn[],
  durationSeconds?: number
): DailyDeepgramTranscriptPayload {
  return {
    language: 'en',
    durationSeconds: durationSeconds ?? null,
    participants: [],
    utterances: turns.map(([speakerLabel, start, end], index) => ({
      userId: null,
      speakerLabel,
      start,
      end,
      transcript: `utterance ${index}`,
      confidence: 0.9,
    })),
    attribution: 'diarized',
  };
}

/** The real normalizer over `diarizedPayload`, so fixture shapes match production. */
export function diarizedCanonical(
  turns: readonly Turn[],
  durationSeconds?: number
): CanonicalTranscript {
  return normalizeDailyDeepgram(diarizedPayload(turns, durationSeconds));
}

export function presenceRow(
  party: MeetingParticipantParty,
  identity: { readonly userId?: string; readonly meetingGuestId?: string },
  joinSec: number,
  leftSec: number | null
): PartyHintPresenceInterval {
  return {
    party,
    userId: identity.userId ?? null,
    meetingGuestId: identity.meetingGuestId ?? null,
    joinedAt: at(joinSec),
    leftAt: leftSec === null ? null : at(leftSec),
  };
}

export function recordingSegment(
  overrides?: Partial<PartyHintRecordingSegment>
): PartyHintRecordingSegment {
  return {
    meetingId: MEETING_ID,
    startedAt: SEGMENT_START,
    durationSeconds: 900,
    ...overrides,
  };
}

/**
 * Expert and client both present for the whole call `[-600, null]` — no attendance-timing cue
 * either way. Turns: speaker-0 `[0,60]`,`[120,180]` (120 s); speaker-1 `[60,120]`,`[180,300]`
 * (180 s). Emits `roster_only`, 40% / 60%.
 */
export function rosterOnlyInput(overrides?: Partial<DerivePartyHintInput>): DerivePartyHintInput {
  const turns: readonly Turn[] = [
    ['speaker-0', 0, 60],
    ['speaker-1', 60, 120],
    ['speaker-0', 120, 180],
    ['speaker-1', 180, 300],
  ];
  const canonical = diarizedCanonical(turns);
  const presence: readonly PartyHintPresenceInterval[] = [
    presenceRow('expert', { userId: EXPERT_USER_ID }, -600, null),
    presenceRow('client', { userId: CLIENT_USER_ID }, -600, null),
  ];
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

/**
 * Expert joins early `[-60, null]`; the client joins later, at `300`. Turns: speaker-0
 * `[10,40]`,`[360,400]`; speaker-1 `[330,360]`,`[400,460]`. Emits `presence_timing`, expert =
 * `speaker-0`, evidence `30_000` ms (the `[10,40]` turn, fully inside the expert-only opening
 * window `[0, 180)`).
 *
 * The turns are also exported as the raw vendor payload (`expertWaitingPayload`) so
 * `pipeline.test.ts` can drive the SAME scenario through `runTranscriptPipeline`'s
 * `normalizeVendorPayload` boundary, rather than injecting a canonical directly.
 */
export const EXPERT_WAITING_TURNS: readonly Turn[] = [
  ['speaker-0', 10, 40],
  ['speaker-1', 330, 360],
  ['speaker-0', 360, 400],
  ['speaker-1', 400, 460],
];

export function expertWaitingPayload(durationSeconds?: number): DailyDeepgramTranscriptPayload {
  return diarizedPayload(EXPERT_WAITING_TURNS, durationSeconds);
}

/**
 * The exact hint `derivePartyHint(expertWaitingInput())` emits — shared across
 * `derive.test.ts`, `resolve.test.ts` and `pipeline.test.ts` so the literal is pinned in ONE
 * place instead of three (SonarCloud new-code duplication).
 */
export const EXPERT_WAITING_HINT: SpeakerPartyHint = {
  basis: 'presence_timing',
  speakers: [
    { ref: 'speaker-0', talkTimePercent: 44 },
    { ref: 'speaker-1', talkTimePercent: 56 },
  ],
  evidence: [{ side: 'expert', speakerRef: 'speaker-0', soleSpeechMs: 30_000 }],
  expertRef: 'speaker-0',
  clientRef: 'speaker-1',
};

export function expertWaitingInput(
  overrides?: Partial<DerivePartyHintInput>
): DerivePartyHintInput {
  const canonical = diarizedCanonical(EXPERT_WAITING_TURNS);
  const presence: readonly PartyHintPresenceInterval[] = [
    presenceRow('expert', { userId: EXPERT_USER_ID }, -60, null),
    presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
  ];
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
