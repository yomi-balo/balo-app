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

/** Nearest knob position (0..10) to a point on the track. Used while dragging the knob itself. */
export function nearestValueFromPointer(offsetX: number, trackWidth: number): number {
  if (trackWidth <= 0) return 0;
  return Math.max(0, Math.min(10, Math.round((offsetX / trackWidth) * 10)));
}

/** Half the knob's hit width. A press this close to the knob grabs it instead of setting a value. */
export const KNOB_HIT_RADIUS_PX = 12;
/** Horizontal travel before a touch counts as a drag rather than a tap or the start of a scroll. */
export const TOUCH_DRAG_SLOP_PX = 6;

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
 * last filled segment. Pressing segment k sets k and pressing left of the track sets 0; grabbing
 * the knob drags it without changing the value until it moves. Touch sets the value on a tap or a
 * horizontal drag, so vertical swipes still scroll the page. Keyboard: arrows ±1, PageUp/PageDown
 * ±2, Home 0, End 10.
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
  // The active press. `onKnob` presses drag the knob to the nearest position and never set a value
  // on their own. `pending` touches commit nothing until they become a tap or a horizontal drag,
  // so a vertical swipe that starts on the slider scrolls the page and leaves the value alone.
  const press = useRef<{ startX: number; onKnob: boolean; pending: boolean } | null>(null);

  const commit = useCallback(
    (next: number): void => {
      if (next !== value) onValueChange(next);
    },
    [value, onValueChange]
  );

  const trackOffset = useCallback((clientX: number): { x: number; width: number } | null => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    return { x: clientX - rect.left, width: rect.width };
  }, []);

  const valueAt = useCallback(
    (clientX: number, onKnob: boolean): number | null => {
      const offset = trackOffset(clientX);
      if (!offset) return null;
      return onKnob
        ? nearestValueFromPointer(offset.x, offset.width)
        : valueFromPointer(offset.x, offset.width);
    },
    [trackOffset]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (disabled) return;
      const offset = trackOffset(e.clientX);
      if (!offset) return;
      const knobX = (value / 10) * offset.width;
      const onKnob = Math.abs(offset.x - knobX) <= KNOB_HIT_RADIUS_PX;
      const pending = e.pointerType === 'touch';
      press.current = { startX: e.clientX, onKnob, pending };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
      if (!onKnob && !pending) commit(valueFromPointer(offset.x, offset.width));
    },
    [disabled, value, trackOffset, commit]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const current = press.current;
      if (disabled || !current) return;
      if (current.pending) {
        if (Math.abs(e.clientX - current.startX) < TOUCH_DRAG_SLOP_PX) return;
        current.pending = false;
      }
      const next = valueAt(e.clientX, current.onKnob);
      if (next !== null) commit(next);
    },
    [disabled, valueAt, commit]
  );

  // A touch that never moved past the slop is a tap: it sets the value under the finger, unless
  // it landed on the knob.
  const handlePointerUp = useCallback((): void => {
    const current = press.current;
    press.current = null;
    if (disabled || !current?.pending || current.onKnob) return;
    const next = valueAt(current.startX, false);
    if (next !== null) commit(next);
  }, [disabled, valueAt, commit]);

  const cancelPress = useCallback((): void => {
    press.current = null;
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
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelPress}
      onKeyDown={handleKeyDown}
      className={cn(
        'focus-visible:ring-ring relative flex min-h-11 touch-pan-y items-center rounded-lg px-[10px] select-none focus:outline-none focus-visible:ring-2 sm:px-[12px]',
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
