/**
 * Skill-bar helper for the 0–10 `expert_competency.proficiency` scale. The level
 * title and description come from `PROFICIENCY_SCALE` in `@balo/shared/experts`.
 */

/** Percentage width for a skill bar (0–10 → 0–100). Clamped to [0, 100]. */
export function proficiencyToPct(value: number): number {
  const pct = (value / 10) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
