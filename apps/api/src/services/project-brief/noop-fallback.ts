import type { BriefParseOutput } from './prompts.js';

/**
 * ⚠⚠ THE SYNTHETIC MARKER. Exported as constants, and asserted against these exact literals in
 * `noop-fallback.test.ts` (fix round F10), because the whole point of this stub is that a human
 * looking at a dev/CI brief can tell AT A GLANCE that no model read anything. A quiet edit that
 * made this read like a real draft would be indistinguishable from one — the failure this file
 * exists to prevent, and it had zero coverage before F10.
 */
export const PROJECT_BRIEF_NOOP_TITLE = 'Draft brief (development placeholder)';

/** The claim-nothing sentence. It must keep saying the documents were NOT read. */
export const PROJECT_BRIEF_NOOP_DISCLAIMER =
  'Development placeholder — no model was called, so the attached documents were not read.';

/**
 * ⚠ DEV/CI ONLY — unreachable in production (`createAiClient` throws when the key is absent).
 * The transcript Noop passes its input through; a brief parse has NO honest passthrough (there
 * is no "the text itself" to hand back for a binary PDF/image), so this returns a VISIBLY
 * SYNTHETIC stub that never claims to have read the documents. Its purpose is exactly the
 * transcript Noop's: let dev + CI exercise the whole path end to end without a key.
 *
 * The parse row will carry `model_id = 'noop'`, which is how an operator tells a stub from a
 * real draft.
 *
 * ⚠ EVERY TAXONOMY ARRAY IS EMPTY, DELIBERATELY. A stub must never put a slug or a label into a
 * draft a human will read as extracted signal.
 */
export function projectBriefNoopResult(fileNames: readonly string[]): BriefParseOutput {
  const fileList = fileNames.map((name) => `- ${name}`).join('\n');
  return {
    title: PROJECT_BRIEF_NOOP_TITLE,
    descriptionMarkdown: `${PROJECT_BRIEF_NOOP_DISCLAIMER}\n\n${fileList}`,
    tagSlugs: [],
    productSlugs: [],
    unmatchedTagLabels: [],
    unmatchedProductLabels: [],
  };
}
