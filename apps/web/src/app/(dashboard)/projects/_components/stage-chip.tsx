import { cn } from '@/lib/utils';
import type { StageKey } from '@/lib/projects-inbox/portfolio-row';

/**
 * StageChip — the design's pipeline-stage pill. Pure + server-safe (no client
 * interactivity). Each stage maps to Balo CSS-variable tokens (never hex):
 * requested → muted, invited → primary, eoi → violet, prop_* → warning,
 * accepted/kicked → success. Dark-aware via the token classes.
 */

interface StageChipProps {
  stage: StageKey;
  label: string;
  className?: string;
}

const STAGE_TONE: Record<StageKey, string> = {
  requested: 'bg-muted text-muted-foreground',
  invited: 'bg-primary/10 text-primary',
  eoi: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  prop_req: 'bg-warning/15 text-warning',
  prop_in: 'bg-warning/15 text-warning',
  accepted: 'bg-success/15 text-success',
  kicked: 'bg-success/15 text-success',
};

export function StageChip({
  stage,
  label,
  className,
}: Readonly<StageChipProps>): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        STAGE_TONE[stage],
        className
      )}
    >
      {label}
    </span>
  );
}
