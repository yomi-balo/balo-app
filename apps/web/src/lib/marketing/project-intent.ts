import type { MarketingHomeProjectSeedTarget } from '@/lib/analytics';
import type { ProjectRequestSeed } from '@/components/balo/project-request/panel';
import { isSeedEmpty } from '@/components/balo/project-request/panel/project-seed';

/**
 * BAL-582 §2 — the marketing home hero's project-intent scorer, ported VERBATIM from the V1.5
 * design reference (`marketing-home.jsx:235-243`; the ref itself is the source of truth — see
 * `plan-bal-582.md` §2). Do not retune the weights or the regexes: a future change here silently
 * re-scores every hero query.
 *
 * Client-consumed (like `is-marketing-home-path.ts`) — no `server-only`, no logging.
 *
 * ⚠ `/i` ONLY, never `/g`. A global regex is STATEFUL across calls (`RegExp.prototype.lastIndex`
 * persists on the object between `.test()` invocations), so a shared `/g` regex would silently
 * mis-score every other call. `project-intent.test.ts` pins that repeated calls return the same
 * score.
 */
const INTENT_SIGNALS: ReadonlyArray<{ re: RegExp; w: number }> = [
  // build verbs
  { re: /\b(implement|migrat|roll[- ]?out|rebuild|integrat|deploy|stand up)\w*/i, w: 3 },
  // scale
  {
    re: /\b(across|org[- ]wide|business units?|all (our )?teams|phases?|end[- ]to[- ]end)\b/i,
    w: 2,
  },
  // timeline
  { re: /\b(weeks?|months?|q[1-4]|go[- ]live|deadline|by end of)\b/i, w: 2 },
  // consultation-shaped
  { re: /\b(error|fails?|broken|not working|bug|debug|why does|how do i)\b/i, w: -3 },
];

/** The score at or above which the intent nudge shows (`use-project-nudge.ts`). */
export const PROJECT_NUDGE_THRESHOLD = 3;

/**
 * A query under 18 trimmed characters is too short to carry intent and scores 0 outright.
 * Otherwise: sum the matching signal weights, +1 for 2-or-more selected products, +1 for a
 * 60-plus character query.
 */
export function projectScore(query: string, productCount: number): number {
  const t = query.trim();
  if (t.length < 18) return 0;
  let score = INTENT_SIGNALS.reduce((acc, { re, w }) => acc + (re.test(t) ? w : 0), 0);
  if (productCount >= 2) score += 1;
  if (t.length >= 60) score += 1;
  return score;
}

/**
 * BAL-582 §3c — the seed rule lives in the HERO, not the panel: a one-liner of 120 characters or
 * fewer becomes the seeded `title`; anything longer becomes `descriptionText`. Hero product
 * selections become `productIds`. An empty (post-trim) query with no selected products yields
 * `seed: undefined` (so the panel opens at `start`, per `initialStepFor`); an empty query with
 * products still yields a non-empty `{ productIds }` seed.
 *
 * `seededInto` reflects the hero's INTENDED target computed from the query alone — reopening the
 * panel with the same search continues the draft and skips a field it already holds
 * (`useProjectSeed`), so this is not applied provenance.
 */
export function seedFromHeroQuery(
  query: string,
  productIds: readonly string[]
): { seed: ProjectRequestSeed | undefined; seededInto: MarketingHomeProjectSeedTarget } {
  const t = query.trim();
  const patch: ProjectRequestSeed = {};
  let seededInto: MarketingHomeProjectSeedTarget = 'none';

  if (t.length > 0) {
    if (t.length <= 120) {
      patch.title = t;
      seededInto = 'title';
    } else {
      patch.descriptionText = t;
      seededInto = 'description';
    }
  }
  if (productIds.length > 0) {
    patch.productIds = [...productIds];
  }

  return { seed: isSeedEmpty(patch) ? undefined : patch, seededInto };
}
