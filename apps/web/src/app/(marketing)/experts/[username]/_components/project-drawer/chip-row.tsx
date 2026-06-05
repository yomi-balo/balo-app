import { cn } from '@/lib/utils';

interface ChipRowProps {
  options: readonly string[];
  /** Currently selected option, or null when nothing is picked. */
  value: string | null;
  /** Called with the new value; clicking the selected chip clears it (null). */
  onChange: (value: string | null) => void;
  /** Accessible group label for the radiogroup. */
  ariaLabel: string;
}

/**
 * Single-select pill row (focus area / budget / timeline). Toggling the active
 * chip clears the selection. 44px tap targets, keyboard-focusable, dark-mode
 * correct via semantic tokens.
 */
export function ChipRow({
  options,
  value,
  onChange,
  ariaLabel,
}: Readonly<ChipRowProps>): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(selected ? null : option)}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none',
              selected
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
