'use client';

import { type ComponentType } from 'react';
import { ChevronDown, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BarSegmentProps {
  icon: ComponentType<LucideProps>;
  /** The small top label (e.g. "Product"). */
  label: string;
  /** The active summary line; `null` falls back to `placeholder`. */
  summary: string | null;
  placeholder: string;
  active: boolean;
  onClick: () => void;
}

/**
 * One segment button of the unified bar: icon + stacked label/summary + chevron.
 * Pure presentational — opening/closing the popover is the parent's concern.
 */
export function BarSegment({
  icon: Icon,
  label,
  summary,
  placeholder,
  active,
  onClick,
}: Readonly<BarSegmentProps>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={active}
      className={cn(
        'flex h-full min-w-0 items-center gap-2.5 px-4 transition-colors',
        active ? 'bg-primary/5' : 'hover:bg-primary/5'
      )}
    >
      <Icon
        className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden
      />
      <span className="flex min-w-0 flex-col items-start">
        <span className="text-muted-foreground text-[11px] leading-tight font-semibold">
          {label}
        </span>
        <span
          className={cn(
            'max-w-[150px] truncate text-sm leading-snug',
            summary ? 'text-foreground font-semibold' : 'text-muted-foreground font-normal'
          )}
        >
          {summary ?? placeholder}
        </span>
      </span>
      <ChevronDown className="text-muted-foreground ml-auto h-3.5 w-3.5 shrink-0" aria-hidden />
    </button>
  );
}
