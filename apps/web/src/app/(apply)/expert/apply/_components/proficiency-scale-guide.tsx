import { PROFICIENCY_SCALE } from '@balo/shared/experts';
import { PROFICIENCY_RAMP_CLASSES } from '@/components/balo/segmented-slider';
import { cn } from '@/lib/utils';

/** The eleven rating levels: a number tile in the slider's ramp colour, the title, then the description. */
export function ProficiencyScaleGuide(): React.JSX.Element {
  return (
    <ol className="m-0 list-none p-0">
      {PROFICIENCY_SCALE.map((level) => (
        <li
          key={level.value}
          className={cn(
            'border-border/60 grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[24px_140px_minmax(0,1fr)]',
            level.value !== 0 && 'border-t'
          )}
        >
          <span
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums',
              PROFICIENCY_RAMP_CLASSES[level.value],
              level.value >= 7 ? 'text-primary-foreground' : 'text-foreground',
              level.value === 0 && 'border-border border'
            )}
          >
            {level.value}
          </span>
          <span className="text-foreground text-[13px] font-semibold">{level.title}</span>
          <span className="text-muted-foreground col-start-2 text-[12.5px] leading-snug sm:col-start-auto">
            {level.description}
          </span>
        </li>
      ))}
    </ol>
  );
}
