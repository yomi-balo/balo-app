'use client';

import { useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

export type ComposerTabId = 'overview' | 'milestones' | 'payment' | 'attachments';

interface ComposerTab {
  id: ComposerTabId;
  label: string;
}

const TABS: ComposerTab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'payment', label: 'Payment & terms' },
  { id: 'attachments', label: 'Attachments' },
];

interface ComposerTabStripProps {
  active: ComposerTabId;
  onChange: (tab: ComposerTabId) => void;
  /** Per-tab "needs attention" dot (drives the amber indicator). */
  issues?: Partial<Record<ComposerTabId, boolean>>;
}

/**
 * The 4-tab segmented control (design `TabStrip`: rounded inset track, active =
 * raised surface + shadow). NOT the shadcn `tabs` primitive — a button-group with
 * `role="tablist"`, horizontally scrollable on mobile (hidden scrollbar). Tab
 * state lives in the composer; this is presentational.
 */
export function ComposerTabStrip({
  active,
  onChange,
  issues,
}: Readonly<ComposerTabStripProps>): React.JSX.Element {
  const handleClick = useCallback((id: ComposerTabId) => () => onChange(id), [onChange]);

  // Roving-focus refs — arrow/Home/End move both selection and DOM focus
  // (activation-follows-focus). Active tab is `tabIndex=0`, the rest `-1`.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (index: number) =>
      (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        const { key } = event;
        let nextIndex: number | null = null;
        if (key === 'ArrowRight') {
          nextIndex = (index + 1) % TABS.length;
        } else if (key === 'ArrowLeft') {
          nextIndex = (index - 1 + TABS.length) % TABS.length;
        } else if (key === 'Home') {
          nextIndex = 0;
        } else if (key === 'End') {
          nextIndex = TABS.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        const nextTab = TABS[nextIndex];
        if (nextTab === undefined) return;
        onChange(nextTab.id);
        tabRefs.current[nextIndex]?.focus();
      },
    [onChange]
  );

  return (
    <div
      role="tablist"
      aria-label="Proposal sections"
      className="bg-muted/60 flex gap-1 overflow-x-auto rounded-[12px] p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab, index) => {
        const isActive = tab.id === active;
        const hasIssue = issues?.[tab.id] === true;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`composer-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`composer-panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={handleClick(tab.id)}
            onKeyDown={handleKeyDown(index)}
            className={cn(
              'focus-visible:ring-ring relative inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-[9px] px-3 text-[13px] font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none',
              isActive
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
            {hasIssue && !isActive && (
              <span
                className="bg-warning h-1.5 w-1.5 shrink-0 rounded-full"
                aria-label="Needs attention"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
