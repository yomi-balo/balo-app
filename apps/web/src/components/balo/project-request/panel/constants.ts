import { Pencil, Sparkles, type LucideIcon } from 'lucide-react';

/**
 * Entry paths shown on the `start` step. `manual` is wired (clickable); `ai`
 * renders as a present-but-disabled "Coming soon" card with an `AI` badge — it
 * has no click handler and never transitions (BAL-253 ships the manual path).
 */
export interface ProjectPath {
  readonly key: 'manual' | 'ai';
  readonly icon: LucideIcon;
  readonly title: string;
  readonly desc: string;
  readonly badge?: string;
  readonly disabled?: boolean;
  /**
   * Visible + announced reason a disabled path is unavailable. Drives both the
   * muted "Coming soon" cue next to the badge and the card's `aria-label` so the
   * reason is perceivable to sighted and AT users alike.
   */
  readonly comingSoonLabel?: string;
}

export const PROJECT_PATHS: readonly ProjectPath[] = [
  {
    key: 'manual',
    icon: Pencil,
    title: 'Describe it yourself',
    desc: 'A couple of sentences is all we need to capture your intent.',
  },
  {
    key: 'ai',
    icon: Sparkles,
    title: "Upload docs — we'll draft it",
    desc: 'Add an RFP, email, or notes. AI writes a short brief you approve.',
    badge: 'AI',
    disabled: true,
    comingSoonLabel: 'Coming soon',
  },
] as const;

/** Stepper steps — the `done` state replaces the stepper with a plain title. */
export const PROJECT_STEPS = [
  { key: 'start', label: 'Start' },
  { key: 'manual', label: 'Describe' },
  { key: 'review', label: 'Review' },
] as const;
