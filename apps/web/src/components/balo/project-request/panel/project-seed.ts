/**
 * BAL-582 (§3b/§3c) — pure helpers for seeding a `ProjectRequestPanel` mount from what a visitor
 * typed in the marketing home hero. No React, no storage, no analytics — trivially unit-testable
 * and safe to import from a pure module.
 *
 * The seed RULE itself (title vs description, the 120-char cutoff) lives in the HERO
 * (`lib/marketing/project-intent.ts`'s `seedFromHeroQuery`), not here — this module only APPLIES
 * an already-decided seed to a draft.
 */

import type { ProjectStep } from '@/lib/analytics';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';
import type { ProjectDraft } from './use-project-draft';

/** What the hero hands the panel. Every field is optional — an empty query seeds nothing. */
export interface ProjectRequestSeed {
  title?: string;
  descriptionText?: string;
  productIds?: string[];
}

/**
 * Escape for TEXT CONTENT: `&`, `<`, `>` — same alphabet and order as
 * `markdown-to-project-html.ts`'s `escapeText`, so a seeded description is escaped exactly the
 * way the AI-brief HTML pipeline escapes text. Not imported from there: that module's escaper is
 * a private, unexported helper of a converter with a much larger contract than this one field.
 */
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A seed with no title, no description text and no product ids is no seed at all. */
export function isSeedEmpty(seed: ProjectRequestSeed | undefined): boolean {
  if (seed === undefined) return true;
  const hasTitle = seed.title !== undefined && seed.title.length > 0;
  const hasDescription = seed.descriptionText !== undefined && seed.descriptionText.length > 0;
  const hasProducts = seed.productIds !== undefined && seed.productIds.length > 0;
  return !hasTitle && !hasDescription && !hasProducts;
}

/**
 * The step a mount should OPEN on (BAL-582 §3b). Resume takes priority over a fresh seed — a
 * resumed 'ai' draft was gated at `upload` (that's where the auth wall sat), everything else
 * resumes at `manual`. A non-empty seed (no resume) skips straight to `manual`; otherwise the
 * mount opens at `start`, exactly as every existing (unseeded) mount does today.
 */
export function initialStepFor(
  seed: ProjectRequestSeed | undefined,
  resumeDraft: boolean,
  draftSource: ProjectDraft['source']
): ProjectStep {
  if (resumeDraft) return draftSource === 'ai' ? 'upload' : 'manual';
  if (!isSeedEmpty(seed)) return 'manual';
  return 'start';
}

/** Plain seed text → the escaped `<p>` HTML the rich-text editor and `validateDescription` both
 *  accept. Matches `markdown-to-project-html.ts`'s D4 output alphabet (a single `<p>` tag). */
export function descriptionTextToHtml(text: string): string {
  return `<p>${escapeText(text)}</p>`;
}

/**
 * The patch to apply to the draft's TEXT fields (BAL-582 §3b / AC7 — "never overwrites an
 * existing draft or in-panel edit"). Title fills only when the draft's title is blank;
 * description fills only when the editor has no meaningful text yet (`isDescriptionEmpty` reads
 * plain-text length, so a cleared editor's autosaved `<p></p>` still counts as empty). A field the
 * seed doesn't carry, or that the draft already holds, is simply absent from the returned patch —
 * never an explicit `undefined` value.
 */
export function seedTextPatch(
  draft: Pick<ProjectDraft, 'title' | 'descriptionHtml'>,
  seed: ProjectRequestSeed
): Partial<Pick<ProjectDraft, 'title' | 'descriptionHtml'>> {
  const patch: Partial<Pick<ProjectDraft, 'title' | 'descriptionHtml'>> = {};
  if (seed.title !== undefined && draft.title.trim() === '') {
    patch.title = seed.title;
  }
  if (seed.descriptionText !== undefined && isDescriptionEmpty(draft.descriptionHtml)) {
    patch.descriptionHtml = descriptionTextToHtml(seed.descriptionText);
  }
  return patch;
}

/**
 * Union the seeded product ids into the draft's own — filtered to ids that actually exist in the
 * loaded products taxonomy (`liveIds`), so a stale id from an earlier taxonomy shape never lands
 * in the draft. The draft's OWN ids are never touched or reordered; only genuinely new, live
 * seeded ids are appended. Returns `null` (no write) when there is nothing new to add — including
 * when every seeded id is already in the draft, or none is live.
 */
export function mergeSeedProductIds(
  draftIds: readonly string[],
  seedIds: readonly string[],
  liveIds: ReadonlySet<string>
): string[] | null {
  const draftIdSet = new Set(draftIds);
  const newIds: string[] = [];
  for (const id of seedIds) {
    if (liveIds.has(id) && !draftIdSet.has(id) && !newIds.includes(id)) {
      newIds.push(id);
    }
  }
  if (newIds.length === 0) return null;
  return [...draftIds, ...newIds];
}
