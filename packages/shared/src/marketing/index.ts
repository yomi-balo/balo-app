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
 * ⚠ SHIPS EMPTY. The list is a content decision and there is no consent record yet —
 * shipping usernames the builder invents would be exactly the misrepresentation D2 exists to
 * prevent. The 0-card state (`apps/web/src/app/(marketing)/_home/experts-section.tsx`) is
 * therefore the shipped default, and it is designed, not degraded. The admin UI to edit this
 * list is out of scope for BAL-493 — editing the const is a code change until BAL-398 lands.
 */
export const FEATURED_EXPERT_USERNAMES: readonly string[] = [] as const;

/** The spotlight never renders more than this many cards, regardless of list length. */
export const FEATURED_EXPERT_LIMIT = 3;
