import { cn } from '@/lib/utils';
import type { DashboardTrackStage } from '@balo/analytics/events';
import type { ProjectsInboxLens } from '@/lib/analytics';
import type { StageKey } from '@/lib/projects-inbox/portfolio-row';
import { participantStageFor } from '@/lib/projects-inbox/project-stages';

/**
 * StageChip — the design's pipeline-stage pill. Pure + server-safe (no client
 * interactivity). Each stage maps to Balo CSS-variable tokens (never hex). Participant lenses
 * colour by the shared participant stage: Invited/Matching → primary, Interest → violet,
 * Proposal(s) → warning, Kickoff/Delivery → success, closed → muted. The admin lens keeps the
 * staff palette per `StageKey`: requested → muted, exploratory → info, invited → primary,
 * eoi → violet, prop_* → warning, accepted/kicked → success. Dark-aware via the token classes.
 */

interface StageChipProps {
  stage: StageKey;
  lens: ProjectsInboxLens;
  label: string;
  className?: string;
}

const ADMIN_STAGE_TONE: Record<StageKey, string> = {
  requested: 'bg-muted text-muted-foreground',
  exploratory: 'bg-info/10 text-info-strong',
  invited: 'bg-primary/10 text-primary',
  eoi: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  prop_req: 'bg-warning/15 text-warning-strong',
  prop_in: 'bg-warning/15 text-warning-strong',
  accepted: 'bg-success/15 text-success-strong',
  kicked: 'bg-success/15 text-success-strong',
  // BAL-540 — the terminal `closed`, toned like `requested` (muted, not a status to celebrate
  // or warn about).
  closed: 'bg-muted text-muted-foreground',
};

const TONE = {
  muted: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  warning: 'bg-warning/15 text-warning-strong',
  success: 'bg-success/15 text-success-strong',
} as const;

const PARTICIPANT_TONE: Record<DashboardTrackStage, string> = {
  invited: TONE.primary,
  matching: TONE.primary,
  eoi: TONE.violet,
  interest: TONE.violet,
  proposal: TONE.warning,
  kickoff: TONE.success,
  delivery: TONE.success,
};

function toneFor(lens: ProjectsInboxLens, stage: StageKey): string {
  if (lens === 'admin') return ADMIN_STAGE_TONE[stage];
  const participant = participantStageFor(lens, stage);
  return participant === null ? TONE.muted : PARTICIPANT_TONE[participant.key];
}

export function StageChip({
  stage,
  lens,
  label,
  className,
}: Readonly<StageChipProps>): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        toneFor(lens, stage),
        className
      )}
    >
      {label}
    </span>
  );
}
