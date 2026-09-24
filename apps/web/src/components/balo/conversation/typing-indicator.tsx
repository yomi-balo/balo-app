'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * The "typing…" line's copy for the resolved typists (first names; `null` = unknown).
 * `null` when nobody is typing. Gender-neutral by construction: names or "someone", never a
 * pronoun. Three or more collapse to one phrase rather than a growing list.
 */
export function typingIndicatorCopy(names: readonly (string | null)[]): string | null {
  if (names.length === 0) return null;
  if (names.length > 2) return 'Several people are typing…';

  const [first = null, second = null] = names;
  if (names.length === 1) return first === null ? 'Someone is typing…' : `${first} is typing…`;

  if (first !== null && second !== null) return `${first} and ${second} are typing…`;
  const known = first ?? second;
  return known === null ? 'Two people are typing…' : `${known} and someone else are typing…`;
}

/**
 * How long the ANNOUNCED text outlives the visible line once nobody is typing.
 *
 * ⚠⚠ WHY THE SCREEN-READER TEXT IS HELD. The sender's 1.5 s idle stop makes the typist SET change
 * on every thinking pause: the line empties, and on the next keystroke it refills — which a live
 * region announces as NEW text. Followed exactly, one considered reply would be announced as
 * "Dana is typing…" once per pause. So the visible line follows the set exactly (AC1's ~2 s
 * clear), while the announced text keeps its last value for this long after the line empties:
 * the same copy coming back inside the window changes nothing in the live region and is not
 * re-announced. A DIFFERENT copy ("Dana and Sam…") is announced at once.
 */
export const TYPING_ANNOUNCE_HOLD_MS = 10_000;

/**
 * Staggered so the three dots ripple rather than move in unison. Explicit keys, not indices.
 * ⚠ Every animation class carries `motion-safe:` — with reduced motion the dots sit still.
 */
const DOTS = [
  { key: 'lead', delay: 'motion-safe:[animation-delay:-0.4s]' },
  { key: 'middle', delay: 'motion-safe:[animation-delay:-0.2s]' },
  { key: 'trail', delay: undefined },
] as const;

interface TypingIndicatorProps {
  /** Resolved typists, in first-seen order — see `resolveTypingNames`. */
  names: readonly (string | null)[];
  /**
   * `false` ⇒ VISUAL ONLY: no live region, and the line is ordinary readable text. For a surface
   * that owns its announcements elsewhere — the call frame keeps ONE polite region (§16).
   */
  announce?: boolean;
  className?: string;
}

/**
 * The text the live region holds: the current copy while anyone types, then the last copy for
 * {@link TYPING_ANNOUNCE_HOLD_MS} after the line empties, then nothing.
 *
 * The render-phase update is React's "adjust state when a prop changes" pattern: `held` tracks
 * the latest non-null copy without an effect-driven extra render, and only the clearing waits on
 * a timer.
 */
function useAnnouncedCopy(copy: string | null): string {
  const [held, setHeld] = useState('');
  if (copy !== null && copy !== held) setHeld(copy);

  useEffect(() => {
    if (copy !== null || held === '') return undefined;
    const timer = setTimeout(() => setHeld(''), TYPING_ANNOUNCE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [copy, held]);

  return copy ?? held;
}

/**
 * The "Dana is typing…" line under a thread.
 *
 * ⚠⚠ THE LIVE REGION IS ALWAYS RENDERED WHILE MOUNTED (when announcing). Assistive tech only
 * announces changes to a live region that already exists; one inserted together with its text is
 * routinely missed, so the first "is typing" would go unheard. It is an `<output>` — the implicit
 * `status` role — rather than `role="status"` on a div (SonarCloud S6819), visually hidden, and
 * holds the ANNOUNCED text ({@link useAnnouncedCopy}); the visible line beside it is
 * `aria-hidden` so browsing does not read it twice.
 *
 * Heartbeats never reach it: the state machine keeps the typist array's identity across them, and
 * an unchanged string leaves the DOM text untouched even on an unrelated re-render. The fixed
 * `min-h-5` line keeps the thread from jumping as the text comes and goes.
 *
 * Mounting it is the caller's decision: render it only when the surface has a typing view.
 * Realtime disabled, or a thread with no live composer, means no typing UI at all — not an
 * empty one.
 */
export function TypingIndicator({
  names,
  announce = true,
  className,
}: Readonly<TypingIndicatorProps>): React.JSX.Element {
  const copy = typingIndicatorCopy(names);
  const announced = useAnnouncedCopy(copy);

  return (
    <div
      className={cn('text-muted-foreground flex min-h-5 items-center gap-1.5 text-xs', className)}
    >
      {announce && (
        <output aria-live="polite" className="sr-only">
          {announced}
        </output>
      )}
      {copy !== null && (
        <>
          <span aria-hidden="true" className="inline-flex items-center gap-0.5">
            {DOTS.map((dot) => (
              <span
                key={dot.key}
                className={cn(
                  'bg-muted-foreground/70 motion-safe:animate-typing-dot size-1 rounded-full',
                  dot.delay
                )}
              />
            ))}
          </span>
          <span aria-hidden={announce || undefined}>{copy}</span>
        </>
      )}
    </div>
  );
}
