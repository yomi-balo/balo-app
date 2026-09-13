import { describe, it, expect } from 'vitest';
import {
  projectBriefNoopResult,
  PROJECT_BRIEF_NOOP_TITLE,
  PROJECT_BRIEF_NOOP_DISCLAIMER,
} from './noop-fallback.js';
import { briefParseOutputSchema } from './prompts.js';

/**
 * BAL-254 fix round F10 — `noop-fallback.ts` had 0% coverage: its thunk is only ever invoked
 * inside `NoopAiClient`, which no test reached. So NOTHING pinned the one property that matters
 * about a dev/CI stub — that it is VISIBLY SYNTHETIC and never claims to have read the documents.
 *
 * The literals below are written out in full, not derived from the module's own constants, so an
 * edit to the copy has to be looked at here rather than silently re-deriving itself green (the
 * `feedback_monitor_strings_need_verbatim_pin` discipline).
 */
describe('projectBriefNoopResult', () => {
  it('the synthetic marker is present — verbatim', () => {
    expect(PROJECT_BRIEF_NOOP_TITLE).toBe('Draft brief (development placeholder)');
    expect(PROJECT_BRIEF_NOOP_DISCLAIMER).toBe(
      'Development placeholder — no model was called, so the attached documents were not read.'
    );
  });

  it('the result carries the marker, so a stub can never be mistaken for a real draft', () => {
    const result = projectBriefNoopResult(['rfp.pdf']);
    expect(result.title).toBe('Draft brief (development placeholder)');
    expect(result.descriptionMarkdown).toContain(
      'Development placeholder — no model was called, so the attached documents were not read.'
    );
  });

  it('⚠ it never claims to have read anything', () => {
    const markdown = projectBriefNoopResult(['rfp.pdf']).descriptionMarkdown;
    expect(markdown).toContain('no model was called');
    expect(markdown).toContain('were not read');
  });

  it('lists the attached filenames as bullets, and nothing else', () => {
    const result = projectBriefNoopResult(['rfp.pdf', 'notes.png']);
    expect(result.descriptionMarkdown).toContain('- rfp.pdf');
    expect(result.descriptionMarkdown).toContain('- notes.png');
  });

  it('⚠ emits NO taxonomy signal — a stub must never populate slugs or unmatched labels', () => {
    const result = projectBriefNoopResult(['rfp.pdf']);
    expect(result.tagSlugs).toEqual([]);
    expect(result.productSlugs).toEqual([]);
    expect(result.unmatchedTagLabels).toEqual([]);
    expect(result.unmatchedProductLabels).toEqual([]);
  });

  it('satisfies the real output schema, so the dev/CI path exercises the same contract', () => {
    expect(briefParseOutputSchema.safeParse(projectBriefNoopResult(['rfp.pdf'])).success).toBe(
      true
    );
  });

  it('clears the usable-output floor even with no filenames (dev/CI completes, never fails)', () => {
    // `parse.ts` rejects `title.trim().length < 3 || descriptionMarkdown.trim().length === 0`.
    const result = projectBriefNoopResult([]);
    expect(result.title.trim().length).toBeGreaterThanOrEqual(3);
    expect(result.descriptionMarkdown.trim().length).toBeGreaterThan(0);
  });
});
