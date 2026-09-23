'use client';

import { Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CompletenessField {
  label: string;
  done: boolean;
}

interface CompletenessBarProps {
  fields: CompletenessField[];
}

/** Below 40% reads as destructive, below 80% as a warning, otherwise as done. */
function toneFor(pct: number): { text: string; bar: string } {
  if (pct < 40) return { text: 'text-destructive-strong', bar: 'bg-destructive' };
  if (pct < 80) return { text: 'text-warning-strong', bar: 'bg-warning' };
  return { text: 'text-success-strong', bar: 'bg-success' };
}

export function CompletenessBar({ fields }: Readonly<CompletenessBarProps>): React.JSX.Element {
  const total = fields.length;
  const done = fields.filter((f) => f.done).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const tone = toneFor(pct);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground text-[13px] font-semibold">Profile completeness</span>
        <span className={cn('text-[13px] font-semibold tabular-nums', tone.text)}>{pct}%</span>
      </div>
      <div
        aria-hidden="true"
        data-testid="completeness-track"
        className="bg-muted h-[5px] overflow-hidden rounded-full"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
            tone.bar
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="mt-0.5 flex flex-col gap-[5px]">
        {fields.map((f) => (
          <li
            key={f.label}
            data-done={String(f.done)}
            className="flex items-center gap-2 text-[12.5px] leading-snug"
          >
            {f.done ? (
              <Check className="text-success-strong h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Circle
                className="text-muted-foreground/50 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
            )}
            <span className={f.done ? 'text-foreground/80' : 'text-muted-foreground'}>
              {f.label}
            </span>
            <span className="sr-only">{f.done ? '(done)' : '(to do)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
