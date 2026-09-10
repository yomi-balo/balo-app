'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ADMIN_SECTION_ORDER, resolveActiveAdminSection } from '../_lib/admin-sections';

/**
 * BAL-548 (folded from the BAL-534 / PR #285 review, item 1) — the `/admin/*` chip sub-nav.
 * BAL-534's pre-flight deferred this: with only one admin page live, a one-chip tab bar would
 * have shipped for nothing. With Home (this ticket) and Config & catalogue as siblings, it now
 * earns its place.
 *
 * Markup — ROUTE LINKS, not the ARIA tabs pattern: these are full navigations to
 * `/admin` / `/admin/catalogue`, not in-page tab panels, so `role="tab"` (which contracts for
 * `aria-controls` → a `role="tabpanel"` sibling + roving-tabindex) would be a false a11y
 * promise — the exact reasoning `settings-section-nav.tsx` documents for its own identical
 * shape. `<nav aria-label>` + `aria-current="page"` is the correct pattern here.
 *
 * 🚩 NO TAB-LEVEL LAYOUT ANIMATION — the ADR-1053 motion AC goes live here: no `layoutId`, no
 * `AnimatePresence`, and no `motion/react` import at all (`invariants/tabs-are-static.test.ts`
 * pins this). The active chip is a static class (`bg-card` + `shadow-sm`), matching
 * `settings-section-nav.tsx` and `expert/settings/_components/settings-tabs.tsx`.
 *
 * Chips below `md`, static tabs at `md`+ — one control, two presentations: the same DOM with
 * `overflow-x-auto` scrolling and tighter padding below `md`; at `md`+ the row already fits
 * (two items), so it reads as a static pill tab bar.
 */
export function AdminSectionNav(): React.JSX.Element {
  const pathname = usePathname();
  const active = resolveActiveAdminSection(pathname);

  return (
    <nav aria-label="Balo admin sections">
      <div className="bg-muted inline-flex max-w-full gap-1 overflow-x-auto rounded-xl p-1">
        {ADMIN_SECTION_ORDER.map(({ key, label, href, icon: Icon }) => {
          const isActive = key === active;
          return (
            <Link
              key={key}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none md:px-4',
                isActive
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn('h-4 w-4', isActive ? 'text-primary' : 'text-muted-foreground')}
              />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
