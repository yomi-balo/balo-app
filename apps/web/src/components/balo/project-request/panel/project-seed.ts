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
 * The step a mount should OPEN on (BAL-582 §3b, BAL-589). A case mount (`isCaseMount`) wins
 * over everything else, including resume: it never has a `start` or `upload` step (BAL-589
 * constants `PROJECT_STEPS_CASE`), so even a resumed `'ai'`-sourced case draft opens at
 * `manual` — the `upload` step simply does not exist on this stepper. Short of that, resume
 * takes priority over a fresh seed — a resumed 'ai' draft was gated at `upload` (that's where
 * the auth wall sat), everything else resumes at `manual`. A non-empty seed (no resume) skips
 * straight to `manual`; otherwise the mount opens at `start`, exactly as every existing
 * (unseeded) mount does today.
 */
export function initialStepFor(
  seed: ProjectRequestSeed | undefined,
  resumeDraft: boolean,
  draftSource: ProjectDraft['source'],
  isCaseMount = false
): ProjectStep {
  if (isCaseMount) return 'manual';
  if (resumeDraft) return draftSource === 'ai' ? 'upload' : 'manual';
  if (!isSeedEmpty(seed)) return 'manual';
  return 'start';
}

/** Plain seed text → the escaped `<p>` HTML the rich-text editor and `validateDescription` both
 *  accept. Matches `markdown-to-project-html.ts`'s D4 output alphabet (a single `<p>` tag). */
export function descriptionTextToHtml(text: string): string {
  return `<p>${escapeText(text)}</p>`;
}

/** The search text a seed carries — its title, or a long search's description — else `null`. */
export function seedSearchText(seed: ProjectRequestSeed): string | null {
  return seed.title ?? seed.descriptionText ?? null;
}

/** Same ids, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Is this seed a NEW search — one that starts a fresh request instead of continuing the draft?
 * What the visitor typed in the hero search bar takes precedence over the autosaved draft, so a
 * title saved on an earlier visit can never pin every later search to it.
 *
 * Only a seed carrying search text can be new (an empty search bar with product chips continues
 * the draft). It continues the draft — is NOT new — when:
 * - the draft was started from this very search (`seededFrom.text`, persisted), whatever has been
 *   edited in the panel since, on this visit or an earlier one; or
 * - the draft already holds exactly this text (a draft no search started, titled the same).
 */
export function isNewSearch(
  draft: Pick<ProjectDraft, 'title' | 'descriptionHtml' | 'seededFrom'>,
  seed: ProjectRequestSeed
): boolean {
  const text = seedSearchText(seed);
  if (text === null) return false;
  if (draft.seededFrom?.text === text) return false;
  if (seed.title !== undefined) return seed.title !== draft.title.trim();
  return descriptionTextToHtml(text) !== draft.descriptionHtml;
}

/** A new search's fresh draft: the seed's text, and a record of the search that started it. */
export function freshDraftFields(
  seed: ProjectRequestSeed
): Pick<ProjectDraft, 'title' | 'descriptionHtml' | 'seededFrom'> {
  return {
    title: seed.title ?? '',
    descriptionHtml:
      seed.descriptionText === undefined ? '' : descriptionTextToHtml(seed.descriptionText),
    seededFrom: { text: seedSearchText(seed), productIds: [...(seed.productIds ?? [])] },
  };
}

/** Did the hero's product chips change since the search that seeded this draft? */
export function seedProductsChanged(
  draft: Pick<ProjectDraft, 'seededFrom'>,
  seed: ProjectRequestSeed
): boolean {
  return !sameIds(seed.productIds ?? [], draft.seededFrom?.productIds ?? []);
}

/**
 * Does the draft hold anything the visitor added THEMSELVES — beyond the text and product chips
 * the search seeded (`seededFrom`)? That is what a new search would set aside, so it decides
 * whether Undo is worth offering, and the offer lapses as soon as the fresh draft gains any.
 * Routing and `source` never count: they are defaults or bookkeeping.
 */
export function hasOwnContent(draft: ProjectDraft): boolean {
  const seededText = draft.seededFrom?.text ?? null;
  const seededIds = new Set(draft.seededFrom?.productIds ?? []);
  const title = draft.title.trim();
  const ownTitle = title !== '' && title !== seededText;
  const ownDescription =
    !isDescriptionEmpty(draft.descriptionHtml) &&
    (seededText === null || draft.descriptionHtml !== descriptionTextToHtml(seededText));
  return (
    ownTitle ||
    ownDescription ||
    draft.productIds.some((id) => !seededIds.has(id)) ||
    draft.tagIds.length > 0 ||
    draft.documents.length > 0 ||
    draft.budgetMinCents !== null ||
    draft.budgetMaxCents !== null ||
    draft.timeline !== null
  );
}

/**
 * The patch to apply to the draft's TEXT fields when the seed CONTINUES the draft (not
 * `isNewSearch`). It only fills a blank field, so an edit made in the panel always survives a
 * reopen: title when the draft's is blank; description when the editor has no meaningful text
 * (`isDescriptionEmpty` reads plain-text length, so a cleared editor's autosaved `<p></p>` still
 * counts as empty). A field the seed doesn't carry, or that the draft already holds, is simply
 * absent from the returned patch — never an explicit `undefined` value.
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
