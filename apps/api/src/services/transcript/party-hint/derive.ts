import type { CanonicalTranscript, TranscriptVendor, MeetingParticipantParty } from '@balo/db';
import type { SpeakerPartyHint, SpeakerPartyHintEvidence, SpeakerTalkTime } from '../llm/types.js';
import { speakerLinePrefix } from '../llm/prompts.js';
import { UNKNOWN_SPEAKER_REF } from '../normalizers/daily-deepgram.js';

/**
 * BAL-517 — the PURE derivation of a non-authoritative, sides-only "party hint" for the
 * SUMMARY + EXTRACTION prompts. No I/O, no wall-clock read, never mutates its inputs. The
 * conservative default: a missing or ambiguous input yields NO hint rather than a wrong one.
 *
 * Tunable rationale (kept in-repo so a future tuner has it in front of them, not only in a
 * planning doc that gets deleted after merge):
 * - `MAX_UNKNOWN_SPEECH_SHARE` (5%): diarization labels nearly every word with `diarize` on, so
 *   a bigger unlabelled share means diarization degraded and a third voice could be hiding in it.
 * - `MIN_SPEAKER_SPEECH_MS` / `MIN_SPEAKER_SHARE` (5s / 5%): a diarization SPLIT of one person
 *   looks like a tiny second ordinal; "two voices, two sides" needs both to have really spoken.
 * - `PRESENCE_SKEW_MARGIN_MS` (120s): covers the per-minute lifecycle sweep's repair lag for a
 *   dropped join webhook, webhook latency, and the `start_ts`→`event_ts`→`receivedAt` anchor
 *   fallback. A clamped `joined_at` (BAL-134 R10, early arrivals raised to `scheduled_start`) can
 *   only make a party look ABSENT earlier than they were, never present when they weren't — so it
 *   can hide evidence, never invent it.
 * - `MIN_SOLE_SPEECH_MS` (3s): a lone "hello?" or a mis-diarized word is not evidence.
 * - `SOLE_SPEECH_DOMINANCE` (90%): tolerates a stray word of diarization spill-over; genuine
 *   disagreement becomes a conflict, which drops the hint entirely.
 *
 * Residual, unverified, documented rather than mitigated: the margin above absorbs
 * error in PRESENCE timestamps, not in the SEGMENT ANCHOR (`meeting_recordings.started_at`). If
 * the anchor is late by more than the margin (e.g. the `receivedAt` fallback fires), every
 * utterance shifts later relative to presence, and a departing party's last words can be
 * misattributed as the remaining party's sole speech. The conflict gate catches this whenever the
 * remaining party also spoke in that window; otherwise it can yield a wrong `presence_timing`
 * mapping, framed as tentative with "the conversation wins" in the prompt.
 */

/** Exported so tests pin boundaries by name. */
export const MIN_SPEAKER_SPEECH_MS = 5_000;
export const MIN_SPEAKER_SHARE = 0.05;
export const MAX_UNKNOWN_SPEECH_SHARE = 0.05;
export const PRESENCE_SKEW_MARGIN_MS = 120_000;
export const MIN_SOLE_SPEECH_MS = 3_000;
export const SOLE_SPEECH_DOMINANCE = 0.9;

/** `speaker-N` only. Bounded, backtracking-free (S5852-safe). */
const DIARIZED_REF_PATTERN = /^speaker-\d{1,4}$/;

export const PARTY_HINT_SKIP_REASONS = [
  // transcript-only (precheck) — evaluated before any DB read
  'vendor_not_daily_deepgram',
  'speakers_not_diarized',
  'speaker_ref_unrecognised',
  'speaker_count_not_two',
  'unknown_speech_too_high',
  'speaker_share_too_low',
  'cleaned_labels_not_preserved',
  // wrapper-owned (resolve.ts) — need the capture id / a lookup
  'capture_id_unrecognised',
  'recording_not_found',
  // segment + presence
  'recording_meeting_mismatch',
  'recording_start_unknown',
  'presence_interval_invalid',
  'presence_identity_missing',
  'presence_observer_present',
  'presence_identity_on_both_sides',
  'expert_identity_count_not_one',
  'client_identity_count_not_one',
  'presence_timing_conflict',
] as const;
export type PartyHintSkipReason = (typeof PARTY_HINT_SKIP_REASONS)[number];

/** Structural subset of a `meeting_presence` row (a `MeetingPresence` satisfies it). */
export interface PartyHintPresenceInterval {
  readonly party: MeetingParticipantParty;
  readonly userId: string | null;
  readonly meetingGuestId: string | null;
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
}

/** Structural subset of a `meeting_recordings` row (a `MeetingRecording` satisfies it). */
export interface PartyHintRecordingSegment {
  readonly meetingId: string;
  readonly startedAt: Date | null;
  readonly durationSeconds: number | null;
}

export interface PartyHintPrecheckInput {
  readonly vendor: TranscriptVendor; // transcripts.vendor
  readonly canonical: CanonicalTranscript;
  readonly cleanedText: string; // EXACTLY the string summary/extraction receive
}

export interface DerivePartyHintInput extends PartyHintPrecheckInput {
  readonly meetingId: string; // transcripts.meeting_id
  readonly recording: PartyHintRecordingSegment;
  readonly presence: readonly PartyHintPresenceInterval[];
}

export interface DiarizedSpeakerPair {
  readonly refs: readonly [string, string]; // canonical first-appearance order
  readonly talkMs: readonly [number, number];
}

export type PartyHintPrecheck =
  | { readonly kind: 'ok'; readonly pair: DiarizedSpeakerPair }
  | { readonly kind: 'none'; readonly reason: PartyHintSkipReason };

export type PartyHintDerivation =
  | { readonly kind: 'hint'; readonly hint: SpeakerPartyHint }
  | { readonly kind: 'none'; readonly reason: PartyHintSkipReason };

// ── Precheck (transcript-only) helpers ──────────────────────────────────────────

function speechMs(seg: { readonly startMs: number; readonly endMs: number }): number {
  return Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs)
    ? Math.max(0, seg.endMs - seg.startMs)
    : 0;
}

function vendorMismatch(input: PartyHintPrecheckInput): boolean {
  return input.vendor !== 'daily_deepgram' || input.canonical.vendor !== 'daily_deepgram';
}

function speakersNotDiarized(canonical: CanonicalTranscript): boolean {
  if (canonical.speakers.length === 0) {
    return true;
  }
  return canonical.speakers.some(
    (speaker) =>
      speaker.source !== 'diarized' || speaker.userId !== null || speaker.displayName !== null
  );
}

function collectKnownRefs(canonical: CanonicalTranscript): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const speaker of canonical.speakers) {
    refs.add(speaker.ref);
  }
  for (const segment of canonical.segments) {
    refs.add(segment.speakerRef);
  }
  return refs;
}

function hasUnrecognisedRef(knownRefs: ReadonlySet<string>): boolean {
  for (const ref of knownRefs) {
    if (ref === UNKNOWN_SPEAKER_REF) {
      continue;
    }
    if (!DIARIZED_REF_PATTERN.test(ref)) {
      return true;
    }
  }
  return false;
}

interface SpeechTally {
  readonly unknownMs: number;
  readonly byRef: ReadonlyMap<string, number>;
}

/** Walks `canonical.segments` in array order — schema-documented as ordered by `startMs`. */
function tallySpeech(canonical: CanonicalTranscript): SpeechTally {
  let unknownMs = 0;
  const byRef = new Map<string, number>();
  for (const segment of canonical.segments) {
    const ms = speechMs(segment);
    if (segment.speakerRef === UNKNOWN_SPEAKER_REF) {
      unknownMs += ms;
      continue;
    }
    byRef.set(segment.speakerRef, (byRef.get(segment.speakerRef) ?? 0) + ms);
  }
  return { unknownMs, byRef };
}

function findLabel(line: string, knownRefs: ReadonlySet<string>): string | undefined {
  for (const ref of knownRefs) {
    if (line.startsWith(speakerLinePrefix(ref))) {
      return ref;
    }
  }
  return undefined;
}

/**
 * True when every non-blank line of `cleanedText` carries a known ref, and the FIRST appearance
 * of `refA` / `refB` is in that canonical order — catching both a partial relabel and a
 * wholesale swap at the opening turns. The Noop path (cleanup returns `renderTranscriptText`
 * verbatim) always passes.
 */
function cleanedLabelsPreserved(
  cleanedText: string,
  knownRefs: ReadonlySet<string>,
  pair: readonly [string, string]
): boolean {
  const [refA, refB] = pair;
  const seen: string[] = [];
  for (const line of cleanedText.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const label = findLabel(line, knownRefs);
    if (label === undefined) {
      return false;
    }
    if ((label === refA || label === refB) && !seen.includes(label)) {
      seen.push(label);
    }
  }
  return seen.length === 2 && seen[0] === refA && seen[1] === refB;
}

/**
 * Precheck: everything derivable from the transcript alone, with NO DB read. `derivePartyHint`
 * calls this first, so it is complete on its own; the async wrapper (`resolve.ts`) calls it
 * separately to avoid a DB read on a transcript that will never qualify.
 */
export function precheckPartyHint(input: PartyHintPrecheckInput): PartyHintPrecheck {
  const { canonical, cleanedText } = input;

  if (vendorMismatch(input)) {
    return { kind: 'none', reason: 'vendor_not_daily_deepgram' };
  }
  if (speakersNotDiarized(canonical)) {
    return { kind: 'none', reason: 'speakers_not_diarized' };
  }
  const knownRefs = collectKnownRefs(canonical);
  if (hasUnrecognisedRef(knownRefs)) {
    return { kind: 'none', reason: 'speaker_ref_unrecognised' };
  }

  const tally = tallySpeech(canonical);
  if (tally.byRef.size !== 2) {
    return { kind: 'none', reason: 'speaker_count_not_two' };
  }
  const [first, second] = [...tally.byRef.entries()];
  if (first === undefined || second === undefined) {
    return { kind: 'none', reason: 'speaker_count_not_two' };
  }
  const [refA, a] = first;
  const [refB, b] = second;
  const total = a + b;
  if (total === 0) {
    return { kind: 'none', reason: 'speaker_share_too_low' };
  }
  if (tally.unknownMs / (tally.unknownMs + total) > MAX_UNKNOWN_SPEECH_SHARE) {
    return { kind: 'none', reason: 'unknown_speech_too_high' };
  }
  if (Math.min(a, b) < MIN_SPEAKER_SPEECH_MS || Math.min(a, b) / total < MIN_SPEAKER_SHARE) {
    return { kind: 'none', reason: 'speaker_share_too_low' };
  }
  if (!cleanedLabelsPreserved(cleanedText, knownRefs, [refA, refB])) {
    return { kind: 'none', reason: 'cleaned_labels_not_preserved' };
  }

  return { kind: 'ok', pair: { refs: [refA, refB], talkMs: [a, b] } };
}

// ── Segment window ───────────────────────────────────────────────────────────────

interface SegmentWindow {
  readonly segStart: number;
  readonly segEnd: number;
  readonly segLengthMs: number;
}

function segmentWindow(
  canonical: CanonicalTranscript,
  recording: PartyHintRecordingSegment,
  segStart: number
): SegmentWindow {
  let lastSpeechEnd = 0;
  for (const segment of canonical.segments) {
    if (Number.isFinite(segment.endMs) && segment.endMs > lastSpeechEnd) {
      lastSpeechEnd = segment.endMs;
    }
  }
  const recordingMs =
    recording.durationSeconds !== null &&
    Number.isFinite(recording.durationSeconds) &&
    recording.durationSeconds >= 0
      ? recording.durationSeconds * 1000
      : 0;
  const segLengthMs = Math.max(recordingMs, canonical.durationMs ?? 0, lastSpeechEnd);
  return { segStart, segEnd: segStart + segLengthMs, segLengthMs };
}

// ── Presence population ────────────────────────────────────────────────────────

function identityKey(row: PartyHintPresenceInterval): string | null {
  if (row.userId !== null) {
    return `user:${row.userId}`;
  }
  if (row.meetingGuestId !== null) {
    return `guest:${row.meetingGuestId}`;
  }
  return null;
}

function intervalEnd(row: PartyHintPresenceInterval): number {
  return row.leftAt === null ? Number.POSITIVE_INFINITY : row.leftAt.getTime();
}

function overlapsWindow(row: PartyHintPresenceInterval, w0: number, w1: number): boolean {
  return row.joinedAt.getTime() <= w1 && intervalEnd(row) >= w0;
}

function hasInvalidInterval(presence: readonly PartyHintPresenceInterval[]): boolean {
  return presence.some(
    (row) =>
      !Number.isFinite(row.joinedAt.getTime()) ||
      (row.leftAt !== null && !Number.isFinite(row.leftAt.getTime()))
  );
}

function distinctKeys(
  rows: readonly PartyHintPresenceInterval[],
  party: MeetingParticipantParty
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.party !== party) {
      continue;
    }
    const key = identityKey(row);
    if (key !== null) {
      keys.add(key);
    }
  }
  return keys;
}

function setsIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) {
      return true;
    }
  }
  return false;
}

type PresencePopulation =
  | { readonly kind: 'ok'; readonly expertKey: string; readonly clientKey: string }
  | { readonly kind: 'none'; readonly reason: PartyHintSkipReason };

/** Steps 11–14 of the plan: identity population over the expanded (X) and strict (S) windows. */
function checkPresencePopulation(
  presence: readonly PartyHintPresenceInterval[],
  window: SegmentWindow
): PresencePopulation {
  const x0 = window.segStart - PRESENCE_SKEW_MARGIN_MS;
  const x1 = window.segEnd + PRESENCE_SKEW_MARGIN_MS;
  const overlappingX = presence.filter((row) => overlapsWindow(row, x0, x1));
  const overlappingS = presence.filter((row) =>
    overlapsWindow(row, window.segStart, window.segEnd)
  );

  if (overlappingX.some((row) => identityKey(row) === null)) {
    return { kind: 'none', reason: 'presence_identity_missing' };
  }
  if (overlappingX.some((row) => row.party === 'observer')) {
    return { kind: 'none', reason: 'presence_observer_present' };
  }

  const expertKeysX = distinctKeys(overlappingX, 'expert');
  const clientKeysX = distinctKeys(overlappingX, 'client');
  if (setsIntersect(expertKeysX, clientKeysX)) {
    return { kind: 'none', reason: 'presence_identity_on_both_sides' };
  }

  const expertKeysS = distinctKeys(overlappingS, 'expert');
  if (expertKeysX.size !== 1 || expertKeysS.size !== 1) {
    return { kind: 'none', reason: 'expert_identity_count_not_one' };
  }
  const clientKeysS = distinctKeys(overlappingS, 'client');
  if (clientKeysX.size !== 1 || clientKeysS.size !== 1) {
    return { kind: 'none', reason: 'client_identity_count_not_one' };
  }

  const [expertKey] = [...expertKeysX];
  const [clientKey] = [...clientKeysX];
  if (expertKey === undefined || clientKey === undefined) {
    return { kind: 'none', reason: 'expert_identity_count_not_one' };
  }
  return { kind: 'ok', expertKey, clientKey };
}

// ── Attendance-timing evidence (steps 15–18) ───────────────────────────────────

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Sorts by start (explicit comparator, S2871), then folds overlapping/touching spans. */
function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/**
 * Raw (unmerged) spans for one identity's presence rows, relative to `segStart`, each widened by
 * `marginMs` on both ends. Shared by `ownSpans` (`marginMs: 0`) and `dilatedSpans` (`marginMs:
 * PRESENCE_SKEW_MARGIN_MS`) so the "walk presence, filter by identity" loop lives in one place.
 */
function rawSpansForKey(
  presence: readonly PartyHintPresenceInterval[],
  key: string,
  segStart: number,
  marginMs: number
): Span[] {
  const raw: Span[] = [];
  for (const row of presence) {
    if (identityKey(row) !== key) {
      continue;
    }
    raw.push({
      start: row.joinedAt.getTime() - segStart - marginMs,
      end: intervalEnd(row) - segStart + marginMs,
    });
  }
  return raw;
}

/** `own(P)`: P's merged spans, clipped to `[0, segLengthMs]`. Drops spans left with `start > end`. */
function ownSpans(
  presence: readonly PartyHintPresenceInterval[],
  key: string,
  segStart: number,
  segLengthMs: number
): Span[] {
  const clipped: Span[] = [];
  for (const span of mergeSpans(rawSpansForKey(presence, key, segStart, 0))) {
    const start = Math.max(0, span.start);
    const end = Math.min(segLengthMs, span.end);
    if (start <= end) {
      clipped.push({ start, end });
    }
  }
  return clipped;
}

/** `dilated(Q)`: Q's merged spans, each widened by the skew margin. Q is NOT clipped first —
 *  only the OTHER party's boundaries are widened, so uncertainty in P's own boundary can only
 *  hide evidence, never invent it. */
function dilatedSpans(
  presence: readonly PartyHintPresenceInterval[],
  key: string,
  segStart: number
): Span[] {
  return mergeSpans(rawSpansForKey(presence, key, segStart, PRESENCE_SKEW_MARGIN_MS));
}

/** `soleRegion(P) = own(P) minus dilated(Q)` — a standard sweep over sorted cut spans. */
function subtractSpans(own: readonly Span[], cuts: readonly Span[]): Span[] {
  const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);
  const result: Span[] = [];
  for (const span of own) {
    let cursor = span.start;
    for (const cut of sortedCuts) {
      if (cut.end <= cursor) {
        continue;
      }
      if (cut.start >= span.end) {
        break;
      }
      if (cut.start > cursor) {
        result.push({ start: cursor, end: cut.start });
      }
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < span.end) {
      result.push({ start: cursor, end: span.end });
    }
  }
  return result.filter((piece) => piece.start < piece.end);
}

interface SoleSpeechBySide {
  readonly expert: readonly [number, number];
  readonly client: readonly [number, number];
}

/** Sums `speechMs` for segments of `ref`, fully contained in a single `region` piece. */
function soleSpeechForSide(
  canonical: CanonicalTranscript,
  ref: string,
  region: readonly Span[]
): number {
  let total = 0;
  for (const segment of canonical.segments) {
    if (segment.speakerRef !== ref) {
      continue;
    }
    const contained = region.some(
      (piece) => piece.start <= segment.startMs && segment.endMs <= piece.end
    );
    if (contained) {
      total += speechMs(segment);
    }
  }
  return total;
}

function computeSoleSpeechBySide(
  canonical: CanonicalTranscript,
  refs: readonly [string, string],
  soleRegionExpert: readonly Span[],
  soleRegionClient: readonly Span[]
): SoleSpeechBySide {
  return {
    expert: [
      soleSpeechForSide(canonical, refs[0], soleRegionExpert),
      soleSpeechForSide(canonical, refs[1], soleRegionExpert),
    ],
    client: [
      soleSpeechForSide(canonical, refs[0], soleRegionClient),
      soleSpeechForSide(canonical, refs[1], soleRegionClient),
    ],
  };
}

type SideLeader =
  | { readonly kind: 'none' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'leader'; readonly index: 0 | 1; readonly ms: number };

function sideLeader(ms: readonly [number, number]): SideLeader {
  const [ms0, ms1] = ms;
  const total = ms0 + ms1;
  if (total < MIN_SOLE_SPEECH_MS) {
    return { kind: 'none' };
  }
  const index: 0 | 1 = ms0 >= ms1 ? 0 : 1;
  const topMs = index === 0 ? ms0 : ms1;
  if (topMs / total < SOLE_SPEECH_DOMINANCE) {
    return { kind: 'conflict' };
  }
  return { kind: 'leader', index, ms: topMs };
}

type TimingDecision =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'roster_only' }
  | {
      readonly kind: 'mapped';
      readonly expertRef: string;
      readonly clientRef: string;
      // Non-empty by construction — built as an array LITERAL of 1 or 2 elements below, never
      // mutated, so no cast is needed to satisfy this tuple type.
      readonly evidence:
        | readonly [SpeakerPartyHintEvidence]
        | readonly [SpeakerPartyHintEvidence, SpeakerPartyHintEvidence];
    };

/**
 * Step 18: a contradiction (either side ambiguous on its own, or both sides point at the SAME
 * voice) proves presence timing / the recording offset / diarization is wrong for this segment,
 * so no hint is emitted at all — never a fallback to `roster_only`.
 */
function decideTiming(
  refs: readonly [string, string],
  expertLeader: SideLeader,
  clientLeader: SideLeader
): TimingDecision {
  if (expertLeader.kind === 'conflict' || clientLeader.kind === 'conflict') {
    return { kind: 'conflict' };
  }
  if (
    expertLeader.kind === 'leader' &&
    clientLeader.kind === 'leader' &&
    expertLeader.index === clientLeader.index
  ) {
    return { kind: 'conflict' };
  }
  if (expertLeader.kind === 'leader') {
    const expertRef = refs[expertLeader.index];
    const clientRefIndex: 0 | 1 = expertLeader.index === 0 ? 1 : 0;
    const clientRef = refs[clientRefIndex];
    const expertEvidence: SpeakerPartyHintEvidence = {
      side: 'expert',
      speakerRef: expertRef,
      soleSpeechMs: expertLeader.ms,
    };
    if (clientLeader.kind === 'leader') {
      const clientEvidence: SpeakerPartyHintEvidence = {
        side: 'client',
        speakerRef: clientRef,
        soleSpeechMs: clientLeader.ms,
      };
      return { kind: 'mapped', expertRef, clientRef, evidence: [expertEvidence, clientEvidence] };
    }
    return { kind: 'mapped', expertRef, clientRef, evidence: [expertEvidence] };
  }
  if (clientLeader.kind === 'leader') {
    const clientRef = refs[clientLeader.index];
    const expertRefIndex: 0 | 1 = clientLeader.index === 0 ? 1 : 0;
    const expertRef = refs[expertRefIndex];
    return {
      kind: 'mapped',
      expertRef,
      clientRef,
      evidence: [{ side: 'client', speakerRef: clientRef, soleSpeechMs: clientLeader.ms }],
    };
  }
  return { kind: 'roster_only' };
}

function buildHint(
  pair: DiarizedSpeakerPair,
  timing: Extract<TimingDecision, { kind: 'roster_only' | 'mapped' }>
): SpeakerPartyHint {
  const [talk0, talk1] = pair.talkMs;
  const p0 = Math.round((100 * talk0) / (talk0 + talk1));
  const p1 = 100 - p0;
  const speakers: readonly [SpeakerTalkTime, SpeakerTalkTime] = [
    { ref: pair.refs[0], talkTimePercent: p0 },
    { ref: pair.refs[1], talkTimePercent: p1 },
  ];
  if (timing.kind === 'roster_only') {
    return { basis: 'roster_only', speakers };
  }
  return {
    basis: 'presence_timing',
    speakers,
    evidence: timing.evidence,
    expertRef: timing.expertRef,
    clientRef: timing.clientRef,
  };
}

/**
 * The full derivation, calling `precheckPartyHint` first (so it is complete on its own), then
 * the segment window + presence population + attendance-timing evidence gates in order. Pure:
 * no I/O, no wall-clock read, never mutates its inputs.
 */
export function derivePartyHint(input: DerivePartyHintInput): PartyHintDerivation {
  const precheck = precheckPartyHint(input);
  if (precheck.kind === 'none') {
    return precheck;
  }
  const { pair } = precheck;
  const { recording, presence, meetingId, canonical } = input;

  if (recording.meetingId !== meetingId) {
    return { kind: 'none', reason: 'recording_meeting_mismatch' };
  }
  if (recording.startedAt === null || !Number.isFinite(recording.startedAt.getTime())) {
    return { kind: 'none', reason: 'recording_start_unknown' };
  }
  const segStart = recording.startedAt.getTime();
  const window = segmentWindow(canonical, recording, segStart);

  if (hasInvalidInterval(presence)) {
    return { kind: 'none', reason: 'presence_interval_invalid' };
  }

  const population = checkPresencePopulation(presence, window);
  if (population.kind === 'none') {
    return population;
  }

  const expertOwn = ownSpans(presence, population.expertKey, segStart, window.segLengthMs);
  const clientOwn = ownSpans(presence, population.clientKey, segStart, window.segLengthMs);
  const expertDilated = dilatedSpans(presence, population.expertKey, segStart);
  const clientDilated = dilatedSpans(presence, population.clientKey, segStart);

  const soleRegionExpert = subtractSpans(expertOwn, clientDilated);
  const soleRegionClient = subtractSpans(clientOwn, expertDilated);

  const soleSpeech = computeSoleSpeechBySide(
    canonical,
    pair.refs,
    soleRegionExpert,
    soleRegionClient
  );
  const timing = decideTiming(
    pair.refs,
    sideLeader(soleSpeech.expert),
    sideLeader(soleSpeech.client)
  );

  if (timing.kind === 'conflict') {
    return { kind: 'none', reason: 'presence_timing_conflict' };
  }

  return { kind: 'hint', hint: buildHint(pair, timing) };
}
