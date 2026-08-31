'use client';

import { useCallback, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CalendarDays, List } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CalendarViewMode = 'week' | 'agenda';

interface CalendarViewSwitcherProps {
  readonly view: CalendarViewMode;
  readonly onChange: (view: CalendarViewMode) => void;
}

const OPTIONS: ReadonlyArray<{ key: CalendarViewMode; label: string; icon: typeof CalendarDays }> =
  [
    { key: 'week', label: 'Week', icon: CalendarDays },
    { key: 'agenda', label: 'Agenda', icon: List },
  ];

/** The shared-layout id that makes the pill SLIDE between options rather than cross-fade. */
const VIEW_PILL_LAYOUT_ID = 'calendar-view-pill';

/**
 * The sliding pill's motion props, as ONE pure function — exported because the repo's
 * `motion/react` test stub strips `layoutId` and `transition` before they reach the DOM, so a
 * render-only test can pin neither arm (BAL-498 fix round 5, B3).
 *
 * ⚠ ~220ms `easeOut`, NOT a spring. balo-ui `references/motion-patterns.md:28` puts a tab
 * switch in the "State change" band (200–300ms, `easeOut`), and the same file's anti-pattern
 * list bans "bounce/spring easings on business UI". The pattern this component copied from
 * `expert/settings/_components/settings-tabs.tsx` ships `{ type: 'spring', duration: 0.35,
 * bounce: 0.15 }` — off-spec on duration AND on easing. Corrected here rather than propagated;
 * `settings-tabs.tsx` is out of this ticket's scope and is deliberately left alone.
 *
 * ⚠⚠ UNDER `prefers-reduced-motion` THE SHARED `layoutId` IS DROPPED ENTIRELY, not merely
 * zeroed. Keeping `layoutId` and setting `duration: 0` still runs a layout projection between
 * the two buttons; dropping it means the pill simply mounts inside the newly-active option,
 * already painted in its final position. The pill still RENDERS — reduced motion removes the
 * movement, never the "which view am I on" affordance — which is why the `duration: 0`
 * transition is kept alongside: it covers the opacity/colour work `motion` would otherwise
 * tween on mount.
 */
export function calendarViewPillMotionProps(reduceMotion: boolean): {
  readonly layoutId: string | undefined;
  readonly transition: { readonly duration: number; readonly ease?: 'easeOut' };
} {
  if (reduceMotion) {
    return { layoutId: undefined, transition: { duration: 0 } };
  }
  return { layoutId: VIEW_PILL_LAYOUT_ID, transition: { duration: 0.22, ease: 'easeOut' } };
}

/**
 * BAL-498 — reuses the pill-with-sliding-indicator pattern shipped in
 * `expert/settings/_components/settings-tabs.tsx`, per the design's explicit "don't invent a
 * fourth tab style" rule. TWO deliberate divergences from it, both repairs rather than new
 * style: the semantics (radiogroup, below) and the pill's TIMING + reduced-motion arm (see
 * {@link calendarViewPillMotionProps} — the source pattern's spring is off-spec against
 * balo-ui's motion table and it handles `prefers-reduced-motion` not at all).
 *
 * ⚠⚠ THIS IS A RADIO GROUP, NOT A TABLIST — DO NOT "RESTORE" `role="tab"` (fix round 3, A3).
 * It shipped announcing "tab, selected" while carrying no `aria-controls`, no `role="tabpanel"`
 * anywhere in the tree, no roving `tabIndex` and no Arrow-key handling: a screen-reader user was
 * told to navigate into a panel that did not exist. The two honest repairs are "complete the tabs
 * pattern" or "downgrade to the pattern that actually matches the widget". Week/Agenda is a
 * choice between two renderings of ONE region, not two panels — `radiogroup`/`radio` says exactly
 * that, needs no panel, and is what the rest of this file's machinery (roving `tabIndex` +
 * Arrow/Home/End) completes.
 */
export function CalendarViewSwitcher({
  view,
  onChange,
}: Readonly<CalendarViewSwitcherProps>): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // `useReducedMotion()` is `boolean | null` (null before the media query resolves) — coerced the
  // way `step-agency.tsx` already does. This is the repo's one mechanism for the preference; no
  // new one is introduced here.
  const reduceMotion = useReducedMotion() ?? false;
  const pillMotion = calendarViewPillMotionProps(reduceMotion);

  const focusOption = useCallback((index: number) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[index]?.focus();
  }, []);

  /**
   * ⚠ ATTACHED TO EACH `role="radio"` BUTTON, NOT TO THE `role="radiogroup"` CONTAINER
   * (BAL-498 fix round 6, item 1). Two reasons, and they agree:
   *
   *  1. APG. A radiogroup container is correctly NOT in the tab order — the radios carry the
   *     roving `tabIndex` this file already implements — so focus is *always* on a radio when
   *     an arrow key is pressed. The container never receives the keystroke first; it only ever
   *     saw it by bubbling. Handling it where it lands is the shape the pattern describes.
   *  2. `jsx-a11y/interactive-supports-focus` (SonarCloud S6853/"radiogroup must be focusable")
   *     fires on an element that owns an interactive role AND a keyboard handler while being
   *     unfocusable. The `tabIndex={-1}` escape hatch would silence it, but it would also make
   *     the group programmatically focusable for no reason. Moving the handler removes the
   *     rule's trigger at the source instead.
   *
   * Behaviour is unchanged: same Arrow/Home/End mapping, same "move and select in one step",
   * same roving focus. The container div keeps only `ref`, `role` and `aria-label`.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const current = OPTIONS.findIndex((option) => option.key === view);
      if (current === -1) return;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (current + 1) % OPTIONS.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (current - 1 + OPTIONS.length) % OPTIONS.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = OPTIONS.length - 1;
      }
      if (nextIndex === null) return;
      const next = OPTIONS[nextIndex];
      if (next === undefined) return;
      event.preventDefault();
      // APG radiogroup: arrow keys MOVE AND SELECT in one step.
      onChange(next.key);
      focusOption(nextIndex);
    },
    [view, onChange, focusOption]
  );

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label="Calendar view"
      className="bg-muted relative inline-flex gap-1 rounded-xl p-1"
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const isActive = view === option.key;
        return (
          <button
            type="button"
            key={option.key}
            role="radio"
            aria-checked={isActive}
            // Roving tabIndex — exactly one stop in the group, as the pattern requires.
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.key)}
            onKeyDown={handleKeyDown}
            className={cn(
              'relative z-10 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-4 py-2 text-sm whitespace-nowrap transition-colors duration-200',
              isActive
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {isActive && (
              <motion.div
                layoutId={pillMotion.layoutId}
                transition={pillMotion.transition}
                data-testid="calendar-view-pill"
                className="bg-card absolute inset-0 rounded-lg shadow-sm"
              />
            )}
            <Icon
              className={cn(
                'relative z-10 h-4 w-4',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
              aria-hidden="true"
            />
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
