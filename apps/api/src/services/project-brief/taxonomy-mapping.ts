import type { ProjectTagsByGroup, ProductsByCategory } from '@balo/db';
import { MAX_UNMATCHED_LABELS, MAX_UNMATCHED_LABEL_LENGTH } from '@balo/shared/project-requests';

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
 * slug with no match, returning those slugs in `unmatchedSlugs`.
 *
 * ⚠ `unmatchedSlugs` IS NOT DECORATION — {@link deriveUnmatchedLabels} turns it into the review
 * step's footnote. It used to be computed and thrown away while the footnote showed the model's
 * OWN `unmatched*Labels` instead, so a slug that missed the taxonomy and was not self-reported
 * vanished silently — precisely the failure that footnote exists to prevent.
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

/** Word separators inside a slug. A `Set` lookup, never a regex (SonarCloud S5852). */
const SLUG_SEPARATORS = new Set(['-', '_', ' ', '\t', '\n', '\r', '.', '/']);

/**
 * `data-migration` → `Data migration`. A bounded left-to-right scan: separators collapse to one
 * space, the result is capped at {@link MAX_UNMATCHED_LABEL_LENGTH}, and the first letter is
 * capitalised. No regex.
 *
 * The slug is the ONLY thing we know about a concept the taxonomy has no row for — there is no
 * `name` to look up, because the lookup is exactly what failed. Showing a de-slugged version of
 * it is strictly more than showing nothing.
 */
function humanizeSlug(slug: string): string {
  let out = '';
  let pendingSpace = false;
  for (const char of slug.trim()) {
    if (SLUG_SEPARATORS.has(char)) {
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (out.length + 1 >= MAX_UNMATCHED_LABEL_LENGTH) break;
      out += ' ';
      pendingSpace = false;
    }
    out += char;
    if (out.length >= MAX_UNMATCHED_LABEL_LENGTH) break;
  }
  return out.length === 0 ? '' : out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * The review step's "we saw these but they are not in the list" footnote (BAL-254 W4).
 *
 * TWO SOURCES, AND BOTH ARE REAL — this is a UNION, deliberately:
 *  1. `unmatchedSlugs` — slugs the model DID emit that the live taxonomy has no row for. These
 *     are the ones that were being lost: `mapSlugsToIds` drops them, and nothing surfaced them.
 *     A model that hallucinates or holds a stale slug never self-reports it, by definition.
 *  2. `modelReportedLabels` — the model's own `unmatched*Labels`, which the prompt asks for when
 *     it recognised a concept it could not match to ANY supplied slug. Dropping this source
 *     would delete the footnote's original, intended path (a concept with no slug at all emits
 *     nothing under source 1).
 *
 * Source 1 leads because it is the evidence-backed half. The list is de-duplicated
 * case-insensitively, each entry bounded to {@link MAX_UNMATCHED_LABEL_LENGTH}, and the whole
 * list to {@link MAX_UNMATCHED_LABELS}.
 *
 * ⚠ DISPLAY-ONLY. These are model-authored, untrusted strings that reach a human as inert React
 * text; they are never submitted, never re-fed to a model, and never become tag/product ids.
 */
export function deriveUnmatchedLabels(
  unmatchedSlugs: readonly string[],
  modelReportedLabels: readonly string[]
): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  const push = (candidate: string): void => {
    const label = candidate.trim().slice(0, MAX_UNMATCHED_LABEL_LENGTH);
    if (label.length === 0) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  };

  for (const slug of unmatchedSlugs) push(humanizeSlug(slug));
  for (const label of modelReportedLabels) push(label);

  return labels.slice(0, MAX_UNMATCHED_LABELS);
}
