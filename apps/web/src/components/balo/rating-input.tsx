'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { RATING_LABELS, RATING_MAX, RATING_MIN, isRating, type Rating } from '@balo/shared/reviews';
import { cn } from '@/lib/utils';

/**
 * RatingInput — the discrete 1–5 CAPTURE control (BAL-390 §6.5).
 *
 * ⚠ DO NOT "unify" this with `components/expert/profile/rating-stars.tsx`. `RatingStars`
 * / `StarRow` are DISPLAY-ONLY: they take `rating: number` and paint a FRACTIONAL fill
 * via an overlay-width clip, which is exactly the wrong internal model for a discrete
 * pick (there is no such thing as tapping 3.6 stars). Two components, two jobs.
 *
 * The accessibility contract is the standard radiogroup one, and every part of it is
 * load-bearing on a control whose entire job is a one-tap answer:
 *   · `role="radiogroup"` wrapping five `role="radio"` buttons.
 *   · ROVING TABINDEX — the group is ONE tab stop, not five. Tab lands on the current
 *     value (or star 1 when unset); arrows move within it.
 *   · `←`/`↓` and `→`/`↑` MOVE **AND** SELECT, `Home`/`End` jump to 1/5. Movement is
 *     CLAMPED, not wrapped: wrapping from 5 round to 1 on a rating scale turns a stray
 *     keypress into the opposite opinion.
 *   · `Enter`/`Space` select via the buttons' native activation — no interception.
 *   · A visible `focus-visible` ring, and a LIVE TEXT LABEL under the row. Colour is
 *     never the only channel, and the word is what makes a mis-tap legible before you
 *     commit to it.
 *
 * Motion is suppressed under `prefers-reduced-motion` via Tailwind's `motion-reduce`
 * variants — the fill still changes, it just changes instantly.
 */

const RATINGS: readonly Rating[] = [1, 2, 3, 4, 5];

/** The mobile tap-target floor. `size` is clamped up to this; never render smaller. */
const MIN_TARGET_PX = 40;

/** The select "pop" duration, per the approved motion table. */
const POP_MS = 200;

export interface RatingInputProps {
  /** The committed rating, or `null` when nothing has been chosen yet. */
  value: Rating | null;
  onChange: (rating: Rating) => void;
  /** Tap-target edge in px — 48 on the landing form, 40 at end-of-call. Clamped to ≥40. */
  size?: number;
  disabled?: boolean;
  /** The radiogroup's accessible name, e.g. "How was working with Amara?". */
  label: string;
  /** DRAFT copy shown in the live label before anything is picked. */
  placeholder?: string;
  className?: string;
}

export function RatingInput({
  value,
  onChange,
  size = 48,
  disabled = false,
  label,
  placeholder = 'Tap a star to rate',
  className,
}: Readonly<RatingInputProps>): React.JSX.Element {
  const [hovered, setHovered] = useState<Rating | null>(null);
  const [popped, setPopped] = useState<Rating | null>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending pop on unmount so the timer never lands on a dead component.
  useEffect(() => {
    return (): void => {
      if (popTimer.current !== null) {
        clearTimeout(popTimer.current);
      }
    };
  }, []);

  const select = useCallback(
    (rating: Rating): void => {
      onChange(rating);
      setPopped(rating);
      if (popTimer.current !== null) {
        clearTimeout(popTimer.current);
      }
      popTimer.current = setTimeout(() => setPopped(null), POP_MS);
    },
    [onChange]
  );

  /** Arrow/Home/End: move focus to the new star AND commit it, the radiogroup contract. */
  const moveTo = useCallback(
    (candidate: number): void => {
      const clamped = Math.min(RATING_MAX, Math.max(RATING_MIN, candidate));
      if (!isRating(clamped)) {
        return;
      }
      select(clamped);
      buttonsRef.current[clamped - 1]?.focus();
    },
    [select]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, star: Rating): void => {
      let candidate: number;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          candidate = star + 1;
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          candidate = star - 1;
          break;
        case 'Home':
          candidate = RATING_MIN;
          break;
        case 'End':
          candidate = RATING_MAX;
          break;
        default:
          return;
      }
      event.preventDefault();
      moveTo(candidate);
    },
    [moveTo]
  );

  const targetPx = Math.max(MIN_TARGET_PX, size);
  const glyphPx = Math.round(targetPx * 0.62);
  // Hover is a PREVIEW only: it never commits, and it reverts on mouseleave.
  const shown = hovered ?? value;
  // The single tab stop: the current value, or the first star when nothing is chosen.
  const activeStar: Rating = value ?? RATING_MIN;

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex items-center justify-center gap-1"
        onMouseLeave={() => setHovered(null)}
      >
        {RATINGS.map((star) => {
          const filled = shown !== null && star <= shown;
          return (
            <button
              key={star}
              ref={(node) => {
                buttonsRef.current[star - 1] = node;
              }}
              type="button"
              role="radio"
              aria-checked={value === star}
              aria-label={`${star} out of 5 — ${RATING_LABELS[star]}`}
              tabIndex={star === activeStar ? 0 : -1}
              disabled={disabled}
              onClick={() => select(star)}
              onKeyDown={(event) => handleKeyDown(event, star)}
              onMouseEnter={() => setHovered(star)}
              style={{ width: targetPx, height: targetPx }}
              className={cn(
                'focus-visible:ring-ring inline-flex items-center justify-center rounded-xl',
                'focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-65'
              )}
            >
              <Star
                aria-hidden="true"
                style={{ width: glyphPx, height: glyphPx }}
                className={cn(
                  'transition-transform duration-150 ease-out motion-reduce:transition-none',
                  filled
                    ? 'fill-warning text-warning'
                    : 'text-muted-foreground/45 fill-transparent',
                  hovered === star && 'scale-110',
                  popped === star && 'scale-[1.18]'
                )}
              />
            </button>
          );
        })}
      </div>

      {/*
        The live word label. `<output>` carries an implicit polite live region, so the
        chosen value is announced without a redundant `role="status"` (which SonarCloud
        flags, S6819). It mirrors the HOVER preview too, so a mouse user reads what they
        are about to pick rather than only what they picked.
      */}
      <output
        className={cn(
          'text-[13px] leading-none font-medium',
          shown === null ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {shown === null ? placeholder : `${shown} — ${RATING_LABELS[shown]}`}
      </output>
    </div>
  );
}
