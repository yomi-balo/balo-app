'use client';

import { useId, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { SLOT_DURATION_LADDER, type SlotDurationMinutes } from '@balo/shared/availability';
import { cn } from '@/lib/utils';

interface LengthControlProps {
  value: SlotDurationMinutes;
  onChange: (next: SlotDurationMinutes) => void;
  isAvailable: (length: SlotDurationMinutes) => boolean;
  /** The look-ahead window, for the disabled-item tooltip. */
  days: number;
}

let indicatorCounter = 0;

const SLIDE_TRANSITION = { type: 'tween', duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;
const INSTANT_TRANSITION = { duration: 0 } as const;

/**
 * Where a key press moves the selection among the enabled lengths, wrapping at both ends. Home
 * and End jump to the first and last enabled length; a `current` outside `enabled` steps in from
 * the matching end.
 */
function nextEnabled(
  enabled: readonly SlotDurationMinutes[],
  current: SlotDurationMinutes,
  key: string
): SlotDurationMinutes | null {
  if (enabled.length === 0) return null;
  if (key === 'Home') return enabled[0] ?? null;
  if (key === 'End') return enabled.at(-1) ?? null;
  const forward = key === 'ArrowRight' || key === 'ArrowDown';
  const backward = key === 'ArrowLeft' || key === 'ArrowUp';
  if (!forward && !backward) return null;
  const index = enabled.indexOf(current);
  if (index === -1) return (forward ? enabled[0] : enabled.at(-1)) ?? null;
  return enabled[(index + (forward ? 1 : -1) + enabled.length) % enabled.length] ?? null;
}

/**
 * The one up-front question, as a segmented radiogroup. The checked item carries a shared-layout
 * indicator that slides between segments; reduced motion swaps it instantly.
 */
export function LengthControl({
  value,
  onChange,
  isAvailable,
  days,
}: Readonly<LengthControlProps>): React.JSX.Element {
  const labelId = useId();
  // Unique per mount, not `useId`: a remount (after "Change") must not slide in from the
  // previous instance's last box, so no two instances ever share a layoutId.
  const [indicatorId] = useState(() => `availability-length-indicator-${++indicatorCounter}`);
  const reduce = useReducedMotion();
  // `null` on the server: treat as sliding so server and first client markup agree.
  const instant = reduce === true;
  const enabled = SLOT_DURATION_LADDER.filter(isAvailable);
  // When the checked length is disabled the group still needs one tab stop: the first enabled.
  const tabStop = enabled.includes(value) ? value : enabled[0];

  function handleKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: SlotDurationMinutes
  ): void {
    const next = nextEnabled(enabled, current, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    const group = event.currentTarget.parentElement;
    group?.querySelector<HTMLButtonElement>(`[data-length="${next}"]`)?.focus();
  }

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3.5">
      <span id={labelId} className="text-foreground text-sm font-medium">
        How long do you need?
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="bg-muted border-input grid w-full grid-cols-4 rounded-[10px] border p-[3px] md:inline-flex md:w-auto"
      >
        {SLOT_DURATION_LADDER.map((d) => {
          const checked = d === value;
          const available = isAvailable(d);
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={d === tabStop ? 0 : -1}
              disabled={!available}
              data-length={d}
              title={available ? undefined : `No ${d}-minute times in the next ${days} days`}
              onClick={() => onChange(d)}
              onKeyDown={(e) => handleKeyDown(e, d)}
              className="focus-visible:ring-ring/50 relative h-[34px] rounded-md px-3 text-sm outline-none focus-visible:ring-[3px] pointer-coarse:h-11"
            >
              {checked && (
                <motion.span
                  layoutId={indicatorId}
                  aria-hidden="true"
                  className="bg-primary absolute inset-0 rounded-[7px] shadow-sm"
                  data-motion={instant ? 'instant' : 'slide'}
                  transition={instant ? INSTANT_TRANSITION : SLIDE_TRANSITION}
                />
              )}
              <span
                className={cn(
                  'relative z-10 transition-colors duration-[260ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none',
                  checked ? 'text-primary-foreground font-semibold' : 'text-muted-foreground',
                  !available && 'opacity-40'
                )}
              >
                {d} min
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
