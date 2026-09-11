/**
 * BAL-549 FIX ROUND (F13) — THE ONE DEFINITION OF THE PROJECT-COUNT RANGE VOCABULARY.
 *
 * `expert_profiles.project_count_min` / `project_lead_count_min` store the LOWER BOUND of a
 * range the applicant picked from a fixed list (`schema/experts.ts`: "None=0, 1-9=1, 10-25=10,
 * 26-50=26, 50+=50"). Three surfaces needed that mapping and each carried its own copy: the
 * applicant's picker (`step-profile.tsx`, a hyphen variant), the applicant's review page
 * (`application-review.tsx`) and the staff review page (`application-sections.tsx`). A stored
 * value is meaningless without this list, so the list belongs beside the vocabulary that
 * produces it — not in three components that can drift apart a label at a time.
 *
 * ⚠ CLIENT-SAFE. No `@balo/db` import, not even type-only: two of the three consumers are
 * `'use client'` leaves (memory `reference_balo_db_client_bundle_footgun`).
 */

/** One selectable range: the value STORED, and the label RENDERED. */
export interface ProjectCountRange {
  /** The lower bound, which is what `project_count_min` stores. */
  readonly min: number;
  readonly label: string;
}

/**
 * The five ranges, in picker order. The labels use an EN DASH (–), not a hyphen — the two
 * render surfaces already did, and a picker that says "1-9" for a value the review page calls
 * "1–9" is the drift this constant exists to end.
 */
export const PROJECT_COUNT_RANGES: readonly ProjectCountRange[] = [
  { min: 0, label: 'None' }, // pending-MJ
  { min: 1, label: '1–9' }, // pending-MJ
  { min: 10, label: '10–25' }, // pending-MJ
  { min: 26, label: '26–50' }, // pending-MJ
  { min: 50, label: '50+' }, // pending-MJ
];

/**
 * The label for a STORED lower bound, or `'—'` when the applicant never answered (null) or the
 * stored value is not one of the five (only reachable from hand-written data).
 */
export function projectRangeLabel(storedMin: number | null | undefined): string {
  if (storedMin === null || storedMin === undefined) return '—';
  const range = PROJECT_COUNT_RANGES.find((candidate) => candidate.min === storedMin);
  return range?.label ?? '—';
}
