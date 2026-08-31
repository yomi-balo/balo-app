'use client';

import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import type { NavSection } from './nav-registry';
import { resolveSidebarNavPill } from './sidebar-nav-pill';

interface SidebarNavSectionProps {
  readonly section: NavSection;
  readonly hrefs: readonly string[];
  readonly children: React.ReactNode;
}

/**
 * BAL-497 (D5) — one sliding active-background pill per sidebar section (primary/secondary),
 * positioned by pure index arithmetic (`resolveSidebarNavPill`) rather than DOM measurement.
 *
 * `relative` lives on THIS wrapper, not on `<nav>`: an absolutely-positioned child resolves
 * `top: 0` against its containing block's PADDING box, and `<nav>` carries `p-3` — that would put
 * the pill 12px too high.
 *
 * Painting order: the pill is first in tree order and positioned (`absolute`); the row stack is
 * non-positioned and comes after it. Both resolve to `z-index: auto`, so tree order alone puts
 * the rows' `relative` links on top of the pill (see `sidebar-nav-link.tsx`) — no `z-` utility
 * needed anywhere.
 *
 * `section` exists only to give the two pills unambiguous test ids
 * (`sidebar-nav-pill-primary` / `-secondary`); the type-only `NavSection` import carries no
 * reference to the nav registry's entry list, so the Scan C invariant
 * (`apps/web/src/invariants/nav-registry-capability-gated.test.ts`) is unaffected.
 */
export function SidebarNavSection({
  section,
  hrefs,
  children,
}: Readonly<SidebarNavSectionProps>): React.JSX.Element {
  const pathname = usePathname();
  const { offsetPx, isVisible } = resolveSidebarNavPill(hrefs, pathname);

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        data-testid={`sidebar-nav-pill-${section}`}
        className={cn(
          'bg-primary/10 pointer-events-none absolute inset-x-0 top-0 h-11 rounded-lg',
          'transition-[transform,opacity]',
          '[transition-duration:.26s,.15s]',
          '[transition-timing-function:cubic-bezier(.4,0,.2,1),ease]',
          'motion-reduce:transition-none',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
        style={{ transform: `translateY(${offsetPx}px)` }}
      />
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
