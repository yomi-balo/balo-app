/**
 * Shared proficiency-scale helpers for the 0–10 `expert_competency.proficiency`
 * scale. The expert apply wizard (assessment-card) and the public profile
 * Expertise bars both derive their level label from this single source so the
 * two never drift.
 *
 *   0      → None
 *   1–3    → Beginner
 *   4–6    → Intermediate
 *   7–8    → Advanced
 *   9–10   → Expert
 */

export type ProficiencyTone = 'muted' | 'warning' | 'primary' | 'success';

export interface ProficiencyLevel {
  label: string;
  /** Semantic tone for badge/text colour, mapped to tokens by the caller. */
  tone: ProficiencyTone;
  /** Tailwind text-colour class for the label (matches the apply wizard). */
  className: string;
}

export function proficiencyToLevel(value: number): ProficiencyLevel {
  if (value <= 0) return { label: 'None', tone: 'muted', className: 'text-muted-foreground' };
  if (value <= 3) return { label: 'Beginner', tone: 'muted', className: 'text-muted-foreground' };
  if (value <= 6) return { label: 'Intermediate', tone: 'warning', className: 'text-warning' };
  if (value <= 8) return { label: 'Advanced', tone: 'primary', className: 'text-primary' };
  return { label: 'Expert', tone: 'success', className: 'text-success' };
}

/** Percentage width for a skill bar (0–10 → 0–100). Clamped to [0, 100]. */
export function proficiencyToPct(value: number): number {
  const pct = (value / 10) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
