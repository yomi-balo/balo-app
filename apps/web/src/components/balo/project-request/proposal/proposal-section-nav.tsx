'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** A reviewable section the nav can jump to / scroll-spy onto. */
export interface ReviewSection {
  key: string;
  label: string;
}

/**
 * The canonical client-review section list (A6.4 / BAL-289). 'Not included' is
 * deliberately absent — it's a contextual aside in the document, not a nav stop.
 * Attachments is the only conditionally-present entry (the parent filters it out
 * when there are no non-terms files).
 */
export const REVIEW_SECTIONS: ReviewSection[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'payment', label: 'Payment terms' },
  { key: 'terms', label: 'Terms' },
  { key: 'attachments', label: 'Attachments' },
];

interface ProposalSectionNavProps {
  /** Anchors are `sec-${proposalId}-${key}` — must match `sectionIdPrefix` on the doc. */
  proposalId: string;
  sections: ReviewSection[];
}

/** True when the OS asks for reduced motion (jump instantly, no smooth scroll). */
function prefersReducedMotion(): boolean {
  return (
    globalThis.window !== undefined &&
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Sticky horizontal chip strip over the proposal document. Click jumps to the
 * section anchor; an `IntersectionObserver` drives the active chip as the user
 * scrolls (scroll-spy). The `rootMargin` pulls the active band just below the
 * sticky nav so the section under it reads as "active". Observer is rebuilt when
 * the proposal (and thus its anchor ids) changes, and torn down on unmount.
 */
export function ProposalSectionNav({
  proposalId,
  sections,
}: Readonly<ProposalSectionNavProps>): React.JSX.Element {
  const firstKey = sections[0]?.key ?? 'overview';
  const [activeKey, setActiveKey] = useState(firstKey);
  // Suppress scroll-spy briefly right after a click so the smooth-scroll doesn't
  // flicker the highlight through intervening sections before it settles.
  const clickLockRef = useRef(false);

  const jump = useCallback(
    (key: string): void => {
      setActiveKey(key);
      const element = document.getElementById(`sec-${proposalId}-${key}`);
      if (element === null) return;
      clickLockRef.current = true;
      element.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      globalThis.setTimeout(() => {
        clickLockRef.current = false;
      }, 600);
    },
    [proposalId]
  );

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const elements = sections
      .map((section) => document.getElementById(`sec-${proposalId}-${section.key}`))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (clickLockRef.current) return;
        // Pick the topmost intersecting section as the active one.
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const [top] = visible;
        if (top === undefined) return;
        setActiveKey(top.target.id.replace(`sec-${proposalId}-`, ''));
      },
      { rootMargin: '-80px 0px -55% 0px', threshold: 0 }
    );

    for (const element of elements) {
      observer.observe(element);
    }
    return (): void => {
      observer.disconnect();
    };
  }, [proposalId, sections]);

  return (
    <nav
      aria-label="Proposal sections"
      className="bg-background sticky top-[62px] z-10 flex gap-1.5 overflow-x-auto py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {sections.map((section) => {
        const active = section.key === activeKey;
        return (
          <button
            key={section.key}
            type="button"
            onClick={() => jump(section.key)}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'focus-visible:ring-ring inline-flex shrink-0 items-center rounded-full border px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none',
              active
                ? 'border-primary/30 bg-primary/5 text-primary'
                : 'border-border bg-card text-muted-foreground hover:text-foreground'
            )}
          >
            {section.label}
          </button>
        );
      })}
    </nav>
  );
}
