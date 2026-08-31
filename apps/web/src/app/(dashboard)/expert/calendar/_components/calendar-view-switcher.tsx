'use client';

import { useCallback, useRef } from 'react';
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

/**
 * BAL-511 / ADR-1053. `.claude/design-references/balo-nav-explorer.jsx`'s motion spec reads:
 *   `tabs  deliberately static — no underline slide, no panel fade, no press scale,
 *          uniform font-weight (animated tabs read as jitter here)`
 * BAL-498 shipped a sliding pill here (`layoutId="calendar-view-pill"`) by copying
 * `settings-tabs.tsx` under a "don't invent a fourth tab style" rule — the right instinct, the
 * wrong precedent. The spec is the precedent, and `settings-tabs.tsx` is flattened in this same
 * PR. BAL-497's sidebar sliding pill is UNAFFECTED — the spec's separate `sidebar pill` line
 * keeps that one deliberately.
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
      className="bg-muted inline-flex gap-1 rounded-xl p-1"
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
              'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-200',
              isActive
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon
              className={cn('h-4 w-4', isActive ? 'text-primary' : 'text-muted-foreground')}
              aria-hidden="true"
            />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
