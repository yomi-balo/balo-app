'use client';

import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface InfoHintProps {
  readonly text: string;
  readonly label?: string;
  /** Tint the trigger for the always-dark hero (light glyph) vs. a light surface. */
  readonly onDark?: boolean;
}

/**
 * BAL-377 — a tappable info hint (Popover, not a hover-only Tooltip) so it works on touch
 * as well as pointer (balo-ui: never hover-only). Used for the A$3/min rate explanation in
 * the hero and the "your bank sets the final rate" note.
 */
export function InfoHint({
  text,
  label = 'More information',
  onDark = false,
}: Readonly<InfoHintProps>) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'focus-visible:ring-ring inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none',
            onDark ? 'text-white/60' : 'text-muted-foreground'
          )}
        >
          <Info className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 text-xs leading-relaxed" side="top">
        {text}
      </PopoverContent>
    </Popover>
  );
}
