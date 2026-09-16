import type { CanonicalTranscript, ExtractedActionItem } from '@balo/db';
import type { LlmAudit } from '../../ai/index.js';

// Single source of truth for the extraction item shape — re-export `@balo/db`'s
// `ExtractedActionItem` (the jsonb `$type` owner) rather than redefine it here, so the
// pipeline, the repository seam, and the LLM client never drift (and SonarCloud sees no dup).
export type { ExtractedActionItem } from '@balo/db';

/**
 * BAL-254 (ADR-1022 amendment) — MOVED to the shared AI seam (`services/ai/types.ts`). Re-exported
 * here, byte-identical shape, so every downstream import (`pipeline.ts`, `transcript_artifacts`
 * mapping) is untouched. Provenance persisted per LLM-derived artifact (ADR-1013: "store cleanup
 * model id + version + prompt" so cleaned-vs-raw stays auditable).
 */
export type { LlmAudit };

/**
 * Which side of the engagement a diarized speaker probably is (BAL-517). Derived from
 * `ExtractedActionItem['assigneeParty']` rather than re-declared, so the two side unions cannot
 * drift — `ExtractedActionItem` is already a type-only import above.
 */
export type SpeakerSide = NonNullable<ExtractedActionItem['assigneeParty']>;

export interface SpeakerTalkTime {
  /** A diarized ref, validated `speaker-N` — never a name, id or participant-entered string. */
  readonly ref: string;
  /** Integer percent of the two hinted voices' speech; the pair sums to 100. */
  readonly talkTimePercent: number;
}

export interface SpeakerPartyHintEvidence {
  readonly side: SpeakerSide;
  readonly speakerRef: string;
  /** Speech ms fully inside a window where attendance records show only `side` present. */
  readonly soleSpeechMs: number;
}

/**
 * BAL-517 — a NON-AUTHORITATIVE, sides-only prompt prior for SUMMARY + EXTRACTION only.
 * ⚠ Never persisted to any identity or party-readable column; never passed to cleanup.
 */
export type SpeakerPartyHint =
  | {
      readonly basis: 'roster_only';
      readonly speakers: readonly [SpeakerTalkTime, SpeakerTalkTime];
    }
  | {
      readonly basis: 'presence_timing';
      readonly speakers: readonly [SpeakerTalkTime, SpeakerTalkTime];
      // Non-empty by construction — a `presence_timing` basis always has at least the leader's
      // own evidence; 1 or 2 entries, expert first.
      readonly evidence:
        | readonly [SpeakerPartyHintEvidence]
        | readonly [SpeakerPartyHintEvidence, SpeakerPartyHintEvidence];
      readonly expertRef: string;
      readonly clientRef: string;
    };

/**
 * The swappable, INJECTABLE LLM seam (ADR-1013 mandates a provider-agnostic layer). The
 * pipeline takes a `LlmClient` in its deps, so unit tests inject a deterministic fake and
 * never hit the live API. The real implementation (`createLlmClient`) is backed by the Vercel
 * AI SDK; a provider swap edits that one module.
 *
 * BAL-517 — `summarize` / `extractActionItems` take a REQUIRED `partyHint: SpeakerPartyHint |
 * null`, so every call site decides explicitly whether a hint applies. `cleanupTranscript`'s
 * signature is UNCHANGED — the type-level pin that the hint never reaches cleanup.
 */
export interface LlmClient {
  cleanupTranscript(input: {
    transcript: CanonicalTranscript;
  }): Promise<{ text: string; audit: LlmAudit }>;
  summarize(input: {
    cleanedText: string;
    partyHint: SpeakerPartyHint | null;
  }): Promise<{ summary: string; audit: LlmAudit }>;
  extractActionItems(input: {
    cleanedText: string;
    summary: string;
    partyHint: SpeakerPartyHint | null;
  }): Promise<{ items: ExtractedActionItem[]; audit: LlmAudit }>;
}
