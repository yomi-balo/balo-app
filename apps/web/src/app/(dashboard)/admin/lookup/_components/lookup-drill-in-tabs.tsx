'use client';

import { useRef } from 'react';

/**
 * BAL-555 — the drill-in's tab bar. Rendered ONLY when the parent has two or more tabs
 * (`lookup-drill-in.tsx`'s `tabs.length >= 2` gate, C2): with one tab, the parent renders the
 * Timeline as a labelled SECTION instead — a one-tab tab bar is still a defect.
 *
 * ⚠ NO `motion/react`, NO `layoutId`, NO `AnimatePresence` (ADR-1053 / BAL-511). Active state
 * is a static class swap; `tabs-are-static.test.ts` fences this file by name.
 *
 * BAL-555 fix round F3 — the full WAI-ARIA APG "tabs" pattern (automatic activation): each tab
 * carries `id` + `aria-controls` pointing at the one visible panel
 * (`lookup-drill-in.tsx` sets that panel's `id` + `aria-labelledby` from {@link panelId} /
 * {@link tabId}), a ROVING `tabIndex` (0 on the active tab, -1 on every other — only one tab
 * sits in the natural Tab order at a time), and `ArrowLeft`/`ArrowRight` (wrapping) plus
 * `Home`/`End` on the tablist move focus AND selection together, matching the existing
 * click-to-select (automatic activation) behaviour rather than introducing a second,
 * manual-activation mode.
 */

export type LookupDrillInTab = 'timeline' | 'money';

interface LookupDrillInTabsProps {
  readonly tabs: readonly { readonly key: LookupDrillInTab; readonly label: string }[];
  readonly active: LookupDrillInTab;
  readonly onSelect: (tab: LookupDrillInTab) => void;
}

/** The one visible `role="tabpanel"`'s `id` for a given tab — shared with `lookup-drill-in.tsx`. */
export function panelId(tab: LookupDrillInTab): string {
  return `lookup-drill-in-panel-${tab}`;
}

/** A tab button's own `id`, referenced by the panel's `aria-labelledby`. */
export function tabId(tab: LookupDrillInTab): string {
  return `lookup-drill-in-tab-${tab}`;
}

export function LookupDrillInTabs({
  tabs,
  active,
  onSelect,
}: Readonly<LookupDrillInTabsProps>): React.JSX.Element {
  const buttonsRef = useRef<Map<LookupDrillInTab, HTMLButtonElement>>(new Map());

  function selectAndFocus(tab: LookupDrillInTab): void {
    onSelect(tab);
    buttonsRef.current.get(tab)?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const currentIndex = tabs.findIndex((tab) => tab.key === active);
    if (currentIndex === -1) return;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = tabs[(currentIndex + 1) % tabs.length];
      if (next !== undefined) selectAndFocus(next.key);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const previous = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
      if (previous !== undefined) selectAndFocus(previous.key);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      const first = tabs[0];
      if (first !== undefined) selectAndFocus(first.key);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const last = tabs[tabs.length - 1];
      if (last !== undefined) selectAndFocus(last.key);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Drill-in sections"
      onKeyDown={handleKeyDown}
      className="bg-muted inline-flex gap-1 rounded-xl p-1"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            type="button"
            key={tab.key}
            ref={(el) => {
              if (el === null) {
                buttonsRef.current.delete(tab.key);
              } else {
                buttonsRef.current.set(tab.key, el);
              }
            }}
            id={tabId(tab.key)}
            role="tab"
            aria-selected={isActive}
            aria-controls={panelId(tab.key)}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            className={
              isActive
                ? 'bg-primary/10 text-primary focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none'
                : 'text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none'
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
