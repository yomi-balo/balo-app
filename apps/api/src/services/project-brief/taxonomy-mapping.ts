import type { ProjectTagsByGroup, ProductsForBriefMapping } from '@balo/db';
import {
  MAX_UNMATCHED_LABELS,
  MAX_UNMATCHED_LABEL_LENGTH,
  normalizeTaxonomyLabel,
} from '@balo/shared/project-requests';

/**
 * BAL-254 (D5, amended by BAL-592) — the model returns taxonomy SLUGS, never UUIDs; this module
 * maps slug → id. PURE — no DB, no I/O. An unrecognised slug is DROPPED by {@link mapSlugsToIds},
 * never guessed at: a hallucinated uuid reaching `tagIds`/`productIds` would detonate
 * `submit-project-request.ts`'s "Some of your selections are no longer available" and fail the
 * whole submit.
 *
 * Ids originate only from Balo-owned rows. A model slug or label is a LOOKUP KEY: for products,
 * {@link resolveLabelsToProducts} may turn one into an id by exact match of its normalised form
 * against the live product names and aliases. Tags have no such path.
 */
export interface TaxonomyChoice {
  readonly slug: string;
  readonly id: string;
  readonly name: string;
  /** The heading this choice is listed under (tag group or product category). */
  readonly group?: string;
  /** Internal, prompt-only product hint. */
  readonly hint?: string;
  /** Features the product includes (`feature` aliases). */
  readonly includes?: readonly string[];
  /** Other names the product is known by (`alt_name` aliases). */
  readonly alsoCalled?: readonly string[];
}

/** Flatten a tags-by-group read into choices. */
export function buildTaxonomyChoices(groups: readonly ProjectTagsByGroup[]): TaxonomyChoice[] {
  const choices: TaxonomyChoice[] = [];
  for (const { group, tags } of groups) {
    for (const tag of tags) {
      choices.push({ slug: tag.slug, id: tag.id, name: tag.name, group: group.name });
    }
  }
  return choices;
}

/** Flatten the brief-mapping product read, carrying each product's hint and aliases. */
export function buildProductChoices(groups: readonly ProductsForBriefMapping[]): TaxonomyChoice[] {
  const choices: TaxonomyChoice[] = [];
  for (const { category, products } of groups) {
    for (const product of products) {
      const includes = product.aliases.filter((a) => a.kind === 'feature').map((a) => a.alias);
      const alsoCalled = product.aliases.filter((a) => a.kind === 'alt_name').map((a) => a.alias);
      choices.push({
        slug: product.slug,
        id: product.id,
        name: product.name,
        group: category.name,
        ...(product.aiHint === null ? {} : { hint: product.aiHint }),
        includes,
        alsoCalled,
      });
    }
  }
  return choices;
}

/**
 * Render the prompt's taxonomy list: a `[group]` header line whenever the group changes, then
 * one `slug — name | hint | includes: … | also called: …` line per choice. Empty or absent
 * segments are omitted.
 */
export function renderTaxonomyChoices(choices: readonly TaxonomyChoice[]): string {
  const lines: string[] = [];
  let currentGroup: string | undefined;
  for (const choice of choices) {
    if (choice.group !== undefined && choice.group !== currentGroup) {
      lines.push(`[${choice.group}]`);
      currentGroup = choice.group;
    }
    const segments = [`${choice.slug} — ${choice.name}`];
    if (choice.hint !== undefined && choice.hint.length > 0) segments.push(choice.hint);
    if (choice.includes !== undefined && choice.includes.length > 0) {
      segments.push(`includes: ${choice.includes.join(', ')}`);
    }
    if (choice.alsoCalled !== undefined && choice.alsoCalled.length > 0) {
      segments.push(`also called: ${choice.alsoCalled.join(', ')}`);
    }
    lines.push(segments.join(' | '));
  }
  return lines.join('\n');
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
 * Lookup index for {@link resolveLabelsToProducts}: the normalised product name, every `includes`
 * entry and every `alsoCalled` entry → product id. Built only from the live choices, so an
 * inactive product's aliases can never enter it. A key claimed by two or more distinct products
 * is AMBIGUOUS and is removed — it resolves to nothing rather than to a guess.
 */
export function buildProductLabelIndex(
  choices: readonly TaxonomyChoice[]
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const choice of choices) {
    const keys = [choice.name, ...(choice.includes ?? []), ...(choice.alsoCalled ?? [])];
    for (const raw of keys) {
      const key = normalizeTaxonomyLabel(raw);
      if (key.length === 0) continue;
      const existing = index.get(key);
      if (existing !== undefined && existing !== choice.id) ambiguous.add(key);
      else index.set(key, choice.id);
    }
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

export interface LabelResolution {
  productIds: string[];
  unresolvedSlugs: string[];
  unresolvedLabels: string[];
  resolvedCount: number;
}

/**
 * The ONLY path by which a model-authored product string becomes a product id: exact lookup of
 * its normalised form in `index`. A slug that missed the taxonomy is humanised first. Anything
 * that does not match is returned untouched so the footnote can still show it.
 *
 * `capacity` bounds the final id list: `selectedIds` (already chosen, they keep priority) plus the
 * newly resolved ids never exceed `maxIds`. A match that would not fit is returned unresolved, as
 * if it had not matched, so its original string still reaches the footnote.
 */
export function resolveLabelsToProducts(
  unmatchedSlugs: readonly string[],
  labels: readonly string[],
  index: ReadonlyMap<string, string>,
  capacity?: { selectedIds: ReadonlySet<string>; maxIds: number }
): LabelResolution {
  const productIds = new Set<string>();
  const unresolvedSlugs: string[] = [];
  const unresolvedLabels: string[] = [];
  let resolvedCount = 0;

  const resolve = (key: string): boolean => {
    const id = index.get(normalizeTaxonomyLabel(key));
    if (id === undefined) return false;
    if (capacity !== undefined && !capacity.selectedIds.has(id) && !productIds.has(id)) {
      const total = capacity.selectedIds.size + productIds.size;
      if (total >= capacity.maxIds) return false;
    }
    productIds.add(id);
    resolvedCount += 1;
    return true;
  };

  for (const slug of unmatchedSlugs) {
    if (!resolve(humanizeSlug(slug))) unresolvedSlugs.push(slug);
  }
  for (const label of labels) {
    if (!resolve(label)) unresolvedLabels.push(label);
  }
  return { productIds: [...productIds], unresolvedSlugs, unresolvedLabels, resolvedCount };
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
 * ⚠ DISPLAY-ONLY, except products. These are model-authored, untrusted strings that reach a
 * human as inert React text. A product label or slug may become an id ONLY through
 * {@link resolveLabelsToProducts}, before this function sees it; what reaches here is what failed
 * that lookup. Tag labels never become ids.
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
