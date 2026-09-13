import type { ProjectTagsByGroup, ProductsByCategory } from '@balo/db';

/**
 * BAL-254 (D5) — the model returns taxonomy SLUGS, never UUIDs; this module maps slug → id.
 * PURE — no DB, no I/O. An unrecognised slug is DROPPED, never guessed at: a hallucinated uuid
 * reaching `tagIds`/`productIds` would detonate `submit-project-request.ts`'s "Some of your
 * selections are no longer available" and fail the whole submit.
 */
export interface TaxonomyChoice {
  readonly slug: string;
  readonly id: string;
  readonly name: string;
}

/** Flatten a grouped taxonomy read (tags-by-group OR products-by-category) into choices. */
export function buildTaxonomyChoices(
  groups: readonly ProjectTagsByGroup[] | readonly ProductsByCategory[]
): TaxonomyChoice[] {
  const choices: TaxonomyChoice[] = [];
  for (const group of groups) {
    const items = 'tags' in group ? group.tags : group.products;
    for (const item of items) {
      choices.push({ slug: item.slug, id: item.id, name: item.name });
    }
  }
  return choices;
}

/** Render `slug — name` lines, one per choice, for the prompt's taxonomy list. */
export function renderTaxonomyChoices(choices: readonly TaxonomyChoice[]): string {
  return choices.map((choice) => `${choice.slug} — ${choice.name}`).join('\n');
}

/**
 * Case/whitespace-tolerant slug → id mapping. De-duplicates the resulting ids and DROPS any
 * slug with no match — its human label (supplied separately by the model as
 * `unmatched*Labels`) is what reaches the client, never the slug itself.
 */
export function mapSlugsToIds(
  slugs: readonly string[],
  choices: readonly TaxonomyChoice[]
): { ids: string[]; unmatchedSlugs: string[] } {
  const bySlug = new Map<string, string>();
  for (const choice of choices) {
    bySlug.set(choice.slug.trim().toLowerCase(), choice.id);
  }

  const ids = new Set<string>();
  const unmatchedSlugs: string[] = [];
  for (const slug of slugs) {
    const id = bySlug.get(slug.trim().toLowerCase());
    if (id === undefined) {
      unmatchedSlugs.push(slug);
      continue;
    }
    ids.add(id);
  }

  // Belt: re-filter against the live choice-id set — a no-op by construction, and a one-line
  // guarantee that no id in the result can have originated from anywhere but `choices` (D5).
  const liveIds = new Set(choices.map((c) => c.id));
  return { ids: [...ids].filter((id) => liveIds.has(id)), unmatchedSlugs };
}
