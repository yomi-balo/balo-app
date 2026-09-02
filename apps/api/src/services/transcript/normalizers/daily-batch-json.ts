/**
 * BAL-483 (§8.2) — Daily Batch Processor `json` output → `DailyDeepgramTranscriptPayload`.
 *
 * The artefact is DEEPGRAM-NATIVE (Daily is a passthrough). Two shapes are accepted:
 *   · `results.utterances[]` — present when Deepgram's `utterances` option is on. Preferred WHEN
 *     NON-EMPTY (FIX ROUND 1, M7) — an `utterances: []` alongside a populated `channels` falls
 *     through to the word-fold path below instead of yielding zero turns.
 *   · `results.channels[0].alternatives[0].words[]` — the shape Daily's own documented sample
 *     shows. Consecutive words sharing a `speaker` ordinal are folded into one turn.
 *
 * ⚠⚠ SPEAKER ATTRIBUTION IS ORDINAL, NOT IDENTITY, AND THAT IS A DOCUMENTED DEGRADATION.
 * The recording is a COMPOSITED single-channel mix (`enable_recording: 'cloud'`), so Deepgram
 * emits `speaker: 0 | 1 | …` and nothing else — there is NO `user_id`, no participant id, no
 * session id anywhere in this artefact. `parseDailyParticipantId` has nothing to parse here;
 * it belongs to the real-time path this ticket does not build. Ordinal `n` maps to the STABLE
 * ref `speaker-n` with `source: 'diarized'` and `userId: null`. A turn with no `speaker` maps
 * to the synthetic `'unknown'` ref — never dropped. See the plan's ⚠ RISK R1 for what the
 * recap loses and why every alternative was rejected.
 *
 * ⚠ THROWS on a body it cannot interpret. The caller classifies that as terminal
 * (`artefact_unreadable`) — a malformed artefact will not become readable on a retry.
 */
import { z } from 'zod';
import type { DailyDeepgramTranscriptPayload, DailyDeepgramUtterance } from './types.js';

const wordSchema = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  speaker: z.number().optional(),
});
type BatchWord = z.infer<typeof wordSchema>;

const utteranceSchema = z.object({
  start: z.number(),
  end: z.number(),
  transcript: z.string(),
  confidence: z.number().optional(),
  speaker: z.number().optional(),
});
type BatchUtterance = z.infer<typeof utteranceSchema>;

const alternativeSchema = z.object({ words: z.array(wordSchema).optional() });
const channelSchema = z.object({ alternatives: z.array(alternativeSchema).optional() });

const metadataSchema = z.object({ duration: z.number().optional() });

/**
 * ⚠ Zod strips unknown keys by default (`.passthrough()` is NOT used) — the same
 * `webhook-events.ts` posture: nothing downstream may read a field this module has not named.
 */
const batchArtefactSchema = z.object({
  metadata: metadataSchema.optional(),
  results: z.object({
    utterances: z.array(utteranceSchema).optional(),
    channels: z.array(channelSchema).optional(),
  }),
});

/**
 * `speaker` (a Deepgram diarization ordinal) → the stable label `speaker-n`, or `null` when the
 * value is absent or not a non-negative integer. `null` is a first-class answer: it becomes
 * `DailyDeepgramUtterance.speakerLabel: null`, which `normalizeDailyDeepgram`'s diarized turn
 * builder maps to the synthetic `'unknown'` ref — never dropped.
 */
function speakerLabelFor(speaker: number | undefined): string | null {
  return typeof speaker === 'number' && Number.isInteger(speaker) && speaker >= 0
    ? `speaker-${speaker}`
    : null;
}

/** Arithmetic mean of the finite confidence values, or `null` when none is finite. */
function meanConfidence(values: readonly (number | undefined)[]): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

/** `results.channels[0].alternatives[0].words[]` — the first alternative of the first channel. */
function wordsFromChannels(
  channels: readonly z.infer<typeof channelSchema>[] | undefined
): readonly BatchWord[] {
  const [firstChannel] = channels ?? [];
  const [firstAlternative] = firstChannel?.alternatives ?? [];
  return firstAlternative?.words ?? [];
}

interface WordGroup {
  readonly label: string | null;
  readonly words: BatchWord[];
}

/** Fold consecutive words sharing the same diarization label into one group. */
function groupConsecutiveByLabel(words: readonly BatchWord[]): WordGroup[] {
  const groups: WordGroup[] = [];
  for (const word of words) {
    const label = speakerLabelFor(word.speaker);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.words.push(word);
    } else {
      groups.push({ label, words: [word] });
    }
  }
  return groups;
}

/** One word group → one `DailyDeepgramUtterance` turn. `null` only for a defensive empty group
 *  (unreachable — {@link groupConsecutiveByLabel} never produces one). */
function turnFromWordGroup(group: WordGroup): DailyDeepgramUtterance | null {
  const [first] = group.words;
  const last = group.words[group.words.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  return {
    userId: null,
    speakerLabel: group.label,
    start: first.start,
    end: last.end,
    transcript: group.words.map((w) => w.punctuated_word ?? w.word).join(' '),
    confidence: meanConfidence(group.words.map((w) => w.confidence)),
  };
}

function turnsFromWords(words: readonly BatchWord[]): DailyDeepgramUtterance[] {
  return groupConsecutiveByLabel(words)
    .map(turnFromWordGroup)
    .filter((turn): turn is DailyDeepgramUtterance => turn !== null);
}

function turnsFromUtterances(utterances: readonly BatchUtterance[]): DailyDeepgramUtterance[] {
  return utterances.map((utterance) => ({
    userId: null,
    speakerLabel: speakerLabelFor(utterance.speaker),
    start: utterance.start,
    end: utterance.end,
    transcript: utterance.transcript,
    confidence:
      typeof utterance.confidence === 'number' && Number.isFinite(utterance.confidence)
        ? utterance.confidence
        : null,
  }));
}

/**
 * Adapt one Daily Batch Processor `json` artefact → `DailyDeepgramTranscriptPayload`,
 * `attribution: 'diarized'` always. `requestedLanguage` is the value Balo ASKED FOR
 * (`inParams.language`) — never inferred from the artefact, which does not carry it (only
 * `metadata.models` does).
 */
export function adaptDailyBatchTranscriptJson(
  raw: unknown,
  requestedLanguage: string | null = 'en'
): DailyDeepgramTranscriptPayload {
  const parsed = batchArtefactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'Daily batch-processor json artefact has an unrecognised shape — cannot adapt (BAL-483)'
    );
  }
  const { metadata, results } = parsed.data;

  const durationSeconds =
    typeof metadata?.duration === 'number' &&
    Number.isFinite(metadata.duration) &&
    metadata.duration >= 0
      ? metadata.duration
      : null;

  // ⚠⚠ FIX ROUND 1 (M7) — PREFER THE NON-EMPTY SOURCE. `results.utterances !== undefined` alone
  // let an `utterances: []` alongside a POPULATED `channels` win and yield zero turns, even
  // though the word-fold path had real content to offer. Falling through to `channels` when
  // `utterances` is present-but-empty keeps the documented preference (utterances win when they
  // carry something) without silently discarding a segment that DID get transcribed.
  const utterances =
    results.utterances !== undefined && results.utterances.length > 0
      ? turnsFromUtterances(results.utterances)
      : turnsFromWords(wordsFromChannels(results.channels));

  return {
    language: requestedLanguage,
    durationSeconds,
    participants: [],
    utterances,
    attribution: 'diarized',
  };
}
