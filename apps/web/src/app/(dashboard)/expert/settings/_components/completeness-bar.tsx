'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CompletenessField {
  label: string;
  done: boolean;
}

interface CompletenessBarProps {
  fields: CompletenessField[];
}

export function CompletenessBar({ fields }: Readonly<CompletenessBarProps>): React.JSX.Element {
  const total = fields.length;
  const done = fields.filter((f) => f.done).length;
  const pct = Math.round((done / total) * 100);

  const colorClass = pct < 40 ? 'text-destructive' : pct < 80 ? 'text-warning' : 'text-success';
  const barColor =
    pct < 40
      ? 'bg-destructive'
      : pct < 80
        ? 'bg-warning'
        : 'bg-gradient-to-r from-emerald-500 to-cyan-500';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-foreground text-xs font-semibold">Profile completeness</span>
        <span className={cn('text-xs font-semibold', colorClass)}>{pct}%</span>
      </div>
      <div className="bg-muted h-1 overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full transition-all duration-500 ease-out', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {fields.map((f) => (
          <div key={f.label} className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all duration-200',
                f.done
                  ? 'from-primary bg-gradient-to-br to-violet-600'
                  : 'border-border bg-muted border-[1.5px]'
              )}
            >
              {f.done && <Check className="h-2.5 w-2.5 text-white" />}
            </div>
            <span
              className={cn(
                'text-xs transition-colors duration-200',
                f.done ? 'text-muted-foreground' : 'text-muted-foreground/60'
              )}
            >
              {f.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
