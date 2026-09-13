import { Pencil, Sparkles, type LucideIcon } from 'lucide-react';

/**
 * Entry paths shown on the `start` step. Both are wired (clickable) — BAL-254 un-disables `ai`:
 * it routes to the new `upload` step instead of the shared `manual` fields screen.
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
  },
] as const;

/** Stepper steps — the `done` state replaces the stepper with a plain title. */
export const PROJECT_STEPS = [
  { key: 'start', label: 'Start' },
  { key: 'manual', label: 'Describe' },
  { key: 'review', label: 'Review' },
] as const;

/**
 * BAL-254 — the AI branch's stepper: same three dots, middle one relabelled + rekeyed to
 * `upload`. Needs no `FlowStepper` change — `current` just has to match one of the keys it was
 * given (`components/flow/stepper.tsx`).
 */
export const PROJECT_STEPS_AI = [
  { key: 'start', label: 'Start' },
  { key: 'upload', label: 'Upload' },
  { key: 'review', label: 'Review' },
] as const;
