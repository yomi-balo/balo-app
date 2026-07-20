import { z } from 'zod';
import type { CanonicalTranscript } from '@balo/db';

/** All prompts are v1 — bump alongside a prompt edit so cleaned-vs-raw stays auditable. */
export const PROMPT_VERSION = 'v1' as const;

export const CLEANUP_PROMPT_ID = 'transcript.cleanup' as const;
export const SUMMARY_PROMPT_ID = 'transcript.summary' as const;
export const EXTRACTION_PROMPT_ID = 'transcript.extract' as const;

/** The rendered prompt: `system` + `user` for the LLM, plus the audit id + version. */
export interface RenderedPrompt {
  system: string;
  user: string;
  promptId: string;
  promptVersion: string;
}

/** Render the canonical transcript as speaker-tagged plain text for the LLM. */
export function renderTranscriptText(transcript: CanonicalTranscript): string {
  const nameByRef = new Map<string, string>();
  for (const speaker of transcript.speakers) {
    nameByRef.set(speaker.ref, speaker.displayName ?? speaker.ref);
  }
  return transcript.segments
    .map((segment) => `${nameByRef.get(segment.speakerRef) ?? segment.speakerRef}: ${segment.text}`)
    .join('\n');
}

const CLEANUP_SYSTEM =
  'You clean up raw meeting-transcript text. Fix ASR errors and remove disfluencies (filler ' +
  'words, false starts, repeated words) while PRESERVING meaning and every speaker turn. Do ' +
  'not summarize, add, or drop content. Keep the "Speaker: text" line format. Return only the ' +
  'cleaned transcript.';

const SUMMARY_SYSTEM =
  'You write a concise recap of a professional consultation. Summarize the key topics, ' +
  'decisions, and outcomes in a few short paragraphs. This recap is shared with BOTH parties, ' +
  'so include only shared meeting context — never pricing, fees, or commercial terms. Return ' +
  'only the summary.';

const EXTRACTION_SYSTEM =
  'You extract concrete action items from a consultation transcript and its summary. Each ' +
  'action item has a short imperative "body", an optional "assigneeParty" which is a SIDE only ' +
  '("client", "expert", or null — NEVER a specific person\'s name), and an optional "dueAt" ' +
  'ISO-8601 date or null. Only include clear, actionable follow-ups; return an empty list if ' +
  'there are none.';

/** v1 cleanup prompt: normalize disfluencies/ASR errors, preserve meaning + speaker turns. */
export function cleanupPrompt(transcript: CanonicalTranscript): RenderedPrompt {
  return {
    system: CLEANUP_SYSTEM,
    user: `Clean up this consultation transcript:\n\n${renderTranscriptText(transcript)}`,
    promptId: CLEANUP_PROMPT_ID,
    promptVersion: PROMPT_VERSION,
  };
}

/** v1 summary prompt: concise, party-safe recap (no fee content). */
export function summaryPrompt(cleanedText: string): RenderedPrompt {
  return {
    system: SUMMARY_SYSTEM,
    user: `Summarize this consultation:\n\n${cleanedText}`,
    promptId: SUMMARY_PROMPT_ID,
    promptVersion: PROMPT_VERSION,
  };
}

/** v1 extraction prompt: enumerate action items with a SIDE-only assignee + optional dueAt. */
export function extractionPrompt(input: { cleanedText: string; summary: string }): RenderedPrompt {
  return {
    system: EXTRACTION_SYSTEM,
    user: `Summary:\n${input.summary}\n\nTranscript:\n${input.cleanedText}\n\nExtract the action items.`,
    promptId: EXTRACTION_PROMPT_ID,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * The extraction output schema — constrains `assigneeParty` to a SIDE (`client` | `expert`) or
 * null (the enum can never represent a specific person) and `dueAt` to an ISO string or null.
 */
export const extractionOutputSchema = z.object({
  items: z
    .array(
      z.object({
        // Bounded as defense-in-depth against a runaway/adversarial transcript — an action-item
        // body is a short imperative; the item count is naturally small for a consultation.
        body: z.string().max(2000),
        assigneeParty: z.enum(['client', 'expert']).nullable(),
        dueAt: z.string().nullable(),
      })
    )
    .max(100),
});

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;
