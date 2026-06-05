'use client';

import { useCallback } from 'react';
import type { ProfileSectionKey } from '@/components/expert/profile';
import { cn } from '@/lib/utils';

export interface NavSection {
  key: ProfileSectionKey;
  label: string;
}

interface StickyNavProps {
  sections: NavSection[];
  active: ProfileSectionKey;
  onJump: (key: ProfileSectionKey) => void;
}

/**
 * Sticky, blurred in-page nav driven by the page-computed `sections` array
 * (data-driven so conditionally-present sections — e.g. Work — appear/disappear
 * cleanly). Horizontal-scrolls on mobile. The active item is bold with an
 * underline and carries `aria-current`.
 */
export function StickyNav({
  sections,
  active,
  onJump,
}: Readonly<StickyNavProps>): React.JSX.Element {
  const handleClick = useCallback((key: ProfileSectionKey) => () => onJump(key), [onJump]);

  return (
    <nav
      aria-label="Profile sections"
      className="border-border/60 bg-background/85 sticky top-0 z-20 border-b backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-[1120px] gap-6 overflow-x-auto px-5 [scrollbar-width:none] md:px-8 [&::-webkit-scrollbar]:hidden">
        {sections.map((section) => {
          const isActive = active === section.key;
          return (
            <button
              key={section.key}
              type="button"
              onClick={handleClick(section.key)}
              aria-current={isActive ? 'true' : undefined}
              className={cn(
                'shrink-0 border-b-2 py-3.5 text-sm whitespace-nowrap transition-colors',
                'focus-visible:ring-ring rounded-t-sm focus-visible:ring-2 focus-visible:outline-none',
                isActive
                  ? 'border-primary text-foreground font-semibold'
                  : 'text-muted-foreground hover:text-foreground border-transparent font-medium'
              )}
            >
              {section.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
