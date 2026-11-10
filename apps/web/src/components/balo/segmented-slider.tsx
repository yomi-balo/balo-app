'use client';

import { useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

/** Fill class per index 0..10. Index 0 is the empty state; 1..10 step up to the full primary. Literals so Tailwind sees them. */
export const PROFICIENCY_RAMP_CLASSES: readonly string[] = [
  'bg-muted',
  'bg-primary/20',
  'bg-primary/30',
  'bg-primary/40',
  'bg-primary/50',
  'bg-primary/60',
  'bg-primary/70',
  'bg-primary/80',
  'bg-primary/90',
  'bg-primary/95',
  'bg-primary',
];

const SEGMENTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Segment k (1..10) covers (k-1)/10..k/10 of the track; a press inside it sets k, and x <= 0 sets 0. */
export function valueFromPointer(offsetX: number, trackWidth: number): number {
  if (offsetX <= 0 || trackWidth <= 0) return 0;
  return Math.min(10, Math.ceil((offsetX / trackWidth) * 10));
}

/** Returns the next value for a key, or null when the key is not handled. */
export function valueFromKey(key: string, value: number): number | null {
  let next: number;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      next = value + 1;
      break;
    case 'ArrowLeft':
    case 'ArrowDown':
      next = value - 1;
      break;
    case 'PageUp':
      next = value + 2;
      break;
    case 'PageDown':
      next = value - 2;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = 10;
      break;
    default:
      return null;
  }
  return Math.max(0, Math.min(10, next));
}

export interface SegmentedSliderProps {
  /** 0..10 */
  value: number;
  onValueChange: (value: number) => void;
  'aria-label': string;
  'aria-valuetext': string;
  disabled?: boolean;
  className?: string;
  /** Rendered inside the track's relative box; children position themselves by percentage. */
  trackOverlay?: React.ReactNode;
}

/**
 * Segmented 0–10 slider. Ten segments fill up to the value and the knob sits at the end of the
 * last filled segment. Keyboard: arrows ±1, PageUp/PageDown ±2, Home 0, End 10.
 */
export function SegmentedSlider({
  value,
  onValueChange,
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  disabled = false,
  className,
  trackOverlay,
}: Readonly<SegmentedSliderProps>): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const commit = useCallback(
    (next: number): void => {
      if (next !== value) onValueChange(next);
    },
    [value, onValueChange]
  );

  const valueAt = useCallback((clientX: number): number | null => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    return valueFromPointer(clientX - rect.left, rect.width);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (disabled) return;
      dragging.current = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.focus();
      const next = valueAt(e.clientX);
      if (next !== null) commit(next);
    },
    [disabled, valueAt, commit]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (disabled || !dragging.current) return;
      const next = valueAt(e.clientX);
      if (next !== null) commit(next);
    },
    [disabled, valueAt, commit]
  );

  const endDrag = useCallback((): void => {
    dragging.current = false;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (disabled) return;
      const next = valueFromKey(e.key, value);
      if (next === null) return;
      e.preventDefault();
      commit(next);
    },
    [disabled, value, commit]
  );

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={10}
      aria-valuenow={value}
      aria-valuetext={ariaValueText}
      aria-disabled={disabled ? 'true' : undefined}
      data-disabled={disabled ? '' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        'focus-visible:ring-ring relative flex min-h-11 touch-none items-center rounded-lg px-[10px] select-none focus:outline-none focus-visible:ring-2 sm:px-[12px]',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className
      )}
    >
      <div ref={trackRef} className="relative flex h-[5px] w-full gap-[3px] sm:h-1">
        {SEGMENTS.map((k) => (
          <div
            key={k}
            data-segment={k}
            className={cn(
              'flex-1 rounded-[2px] transition-colors duration-100',
              k <= value ? PROFICIENCY_RAMP_CLASSES[k] : 'bg-border'
            )}
          />
        ))}
        {trackOverlay}
        <div
          aria-hidden="true"
          className="bg-background border-primary absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-[left] duration-100 sm:size-5"
          style={{ left: `${value * 10}%` }}
        />
      </div>
    </div>
  );
}
