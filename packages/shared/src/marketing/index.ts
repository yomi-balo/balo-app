/**
 * BAL-493 / D2 — the curated marketing spotlight.
 *
 * ⚠ THESE ARE TYPED CONSTS, NOT CONFIG. There is NO `platform_config` table and NO config
 * module on main: BAL-398 / PR #180 is unmerged — verified in this worktree (no schema, no
 * migration; all repo hits for `platform_config` are docblocks asserting its absence).
 * House precedents for this treatment: `SLOT_STEP_MINUTES` (@balo/shared/availability),
 * `LOW_RATING_THRESHOLD` (@balo/shared/reviews), `billingFloorMinutes` (apps/api/src/config).
 * This module is the natural first migration when BAL-398 lands.
 *
 * ⚠⚠ THIS LIST IS THE CONSENT RECORD. There is no "agreed to be featured" column anywhere in
 * the schema and this ticket deliberately adds none (D2). An expert appears here ONLY after
 * consent has been obtained out of band, by a human editing this file. Do NOT generate,
 * backfill, or derive entries — a deterministic fallback would put a real person on the public
 * front page without anyone having decided to.
 *
 * ⚠ NOT A VISIBILITY BYPASS. Every entry is re-checked at read time against the canonical
 * public predicate (`searchable = true AND approved_at IS NOT NULL`) via
 * `expertsRepository.findPublicProfileByUsername`. An expert who turns off `searchable` or
 * loses approval drops out of the spotlight automatically and immediately.
 *
 * ⚠ ZERO IMPORTS, DELIBERATELY (see @balo/shared/availability for the Turbopack rationale).
 * No `.js` extensions on any relative import in packages/shared.
 *
 * ⚠⚠ THE ENTRIES BELOW ARE SEEDED TEST DATA, NOT CURATED REAL EXPERTS. They are usernames
 * from the dev database's generated fixtures, added at Yomi's request so the spotlight renders
 * during development. They are NOT a consent record and MUST be replaced before this surface
 * is shown to real traffic. Two properties make that safe to sit here in the meantime:
 *   1. the read re-checks `searchable = true AND approved_at IS NOT NULL` per entry, and
 *   2. an unresolvable username is simply omitted (`load-home-data.ts`), so in an environment
 *      where these fixtures do not exist the section falls back to its 0-card invitation state
 *      rather than erroring.
 * When real experts are curated, REPLACE this array wholesale and delete this warning.
 *
 * The 0-card state (`apps/web/src/app/(marketing)/_home/experts-section.tsx`) remains a
 * designed state, not a degraded one — it is what an empty or fully-filtered list renders.
 * The admin UI to edit this list is out of scope for BAL-493 — editing the const is a code
 * change until BAL-398 lands.
 */
export const FEATURED_EXPERT_USERNAMES: readonly string[] = [
  // TODO(Yomi/MJ): dev-fixture usernames — replace with consented real experts before launch.
  'gustavo-cruickshank-1',
  'herbert-connelly-2',
  'freda-macgyver-3',
] as const;

/** The spotlight never renders more than this many cards, regardless of list length. */
export const FEATURED_EXPERT_LIMIT = 3;
