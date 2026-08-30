'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { track, NAV_EVENTS } from '@/lib/analytics';
import { Sheet, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useSidebar } from './sidebar-context';
import { resolveMobileTabs, resolveMoreItems, type EnabledNavEntry } from './nav-registry';
import { useNavItemTracking } from './use-nav-item-tracking';
import { hasMoreAttention, moreButtonLabel } from './nav-badges';
import { isNavItemActive } from './is-nav-item-active';
import { MobileMoreSheet } from './mobile-more-sheet';

const CELL_CLASSNAME =
  'flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

const LABEL_CLASSNAME_INACTIVE = 'text-muted-foreground text-[10.5px] leading-none font-medium';
const LABEL_CLASSNAME_ACTIVE = 'text-primary text-[10.5px] leading-none font-semibold';

interface TabCellProps {
  readonly entry: EnabledNavEntry;
  readonly isActive: boolean;
  readonly onClick: () => void;
}

function TabCell({ entry, isActive, onClick }: Readonly<TabCellProps>): React.JSX.Element {
  const Icon = entry.icon;
  return (
    <Link
      href={entry.href}
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      className={CELL_CLASSNAME}
    >
      {/* `key` remount replays the pop animation on every active-state change — the same
          remount-to-replay trick the prototype uses (balo-nav-explorer.jsx:2384-2386). */}
      <Icon
        key={isActive ? 'on' : 'off'}
        className={cn(
          'size-[22px]',
          isActive ? 'text-primary animate-tab-icon-pop' : 'text-muted-foreground'
        )}
        strokeWidth={isActive ? 2.2 : 1.8}
        aria-hidden="true"
      />
      <span className={isActive ? LABEL_CLASSNAME_ACTIVE : LABEL_CLASSNAME_INACTIVE}>
        {entry.shortLabel ?? entry.label}
      </span>
    </Link>
  );
}

/**
 * BAL-501 — the persistent bottom tab bar (ADR-1053), replacing the hamburger drawer. `<nav
 * aria-label="Primary">` sits `sticky bottom-0` INSIDE the dashboard column (§2.3 — never
 * `fixed`, so `<main>` needs no bottom padding and `AppFooter` needs no changes) and `lg:hidden`
 * (§2.1 — CSS gate, never `useIsMobile`, to avoid a first-paint flash).
 */
export function MobileTabBar(): React.JSX.Element | null {
  const { navContext, checklistCompletedCount, checklistAllComplete } = useSidebar();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // D19 — the ONE surviving `useIsMobile` use in this feature, for BEHAVIOUR only, never
  // visibility. The More `Sheet` is a Radix portal: if it's open and the viewport crosses
  // 1024px (tablet rotation, a resized window), the trigger disappears under `lg:hidden` while
  // the portal'd sheet stays open, orphaned beside the now-visible sidebar. This effect closes
  // it. It cannot flash: the hook's `false` first-paint value only ever forces the sheet
  // CLOSED, which is already its initial state, and it never participates in a render branch.
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!isMobile) setMoreOpen(false);
  }, [isMobile]);

  const tabs = resolveMobileTabs(navContext);
  const moreItems = resolveMoreItems(navContext);
  const trackNavItem = useNavItemTracking('bottom_tabs', navContext.workspaceType);

  if (tabs.length === 0 && moreItems.length === 0) return null; // unreachable today; honest

  const needsAttention = hasMoreAttention(moreItems, {
    checklistCompletedCount,
    checklistAllComplete,
  });
  /*
   * ⚠ A POSITIVE rule, deliberately NOT `!tabs.some(...)`. `isNavItemActive` is a pure href-prefix
   * rule, but an entity route reaches its list only via `ENTITY_PARENTS` in the breadcrumb
   * resolver: `/cases/:id` and `/meetings/:id` belong to Consultations, whose tab href is
   * `/consultations`, so NO tab prefix-matches them. A negated rule would light More on every case
   * and meeting page — directly contradicting the top bar's own "Back to Consultations" crumb.
   * Desktop shares the rule gap but fails NEUTRAL (nothing lit); a negated fallback turns that gap
   * into a WRONG signal. Same for `/engagements`, `/billing/top-up`, `/promo-codes`, `/redeem`,
   * none of which is a registry entry.
   *
   * Teaching `isNavItemActive` about `ENTITY_PARENTS` is the proper fix, but it also changes
   * BAL-495's FROZEN desktop rule, so it needs its own ticket and its own pin in `sidebar.test.tsx`
   * rather than riding along here.
   */
  const moreActive = moreOpen || moreItems.some((entry) => isNavItemActive(pathname, entry.href));

  const handleOpenChange = (open: boolean): void => {
    setMoreOpen(open);
    // MENU-OPEN ONLY, mirroring workspace-switcher.tsx's SWITCHER_OPENED — the open→act funnel
    // is the business question; emitting on close would double the denominator.
    if (open) track(NAV_EVENTS.MORE_OPENED, { workspace_type: navContext.workspaceType });
  };

  return (
    <Sheet open={moreOpen} onOpenChange={handleOpenChange}>
      {/* D17 — a STATIC class pair, never `grid-cols-${n}` (Tailwind can't see a runtime
          string; the bar would silently collapse to one column). D12 — `z-40`, never `z-50`:
          this bar must sit UNDER the sheet it opens. */}
      <nav
        aria-label="Primary"
        className="bg-background border-border sticky bottom-0 z-40 grid shrink-0 auto-cols-fr grid-flow-col border-t pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden"
      >
        {tabs.map((entry) => (
          <TabCell
            key={entry.key}
            entry={entry}
            isActive={isNavItemActive(pathname, entry.href)}
            onClick={() => trackNavItem(entry.key)}
          />
        ))}
        <SheetTrigger asChild>
          <button
            type="button"
            className={CELL_CLASSNAME}
            /* ⚠ The `1` is a LITERAL, honest only while `expertChecklist` is the sole
               `NavBadgeSource`. `hasMoreAttention` is a predicate, so the `Record<NavBadgeSource>`
               guard forces a new PREDICATE for a second source — never a new COUNT — and this label
               would then silently say "1 item" for two. `countMoreAttention` (the deferred
               follow-up) is what makes it honest; wire it here when a second source lands. */
            aria-label={moreButtonLabel(needsAttention ? 1 : 0)}
          >
            <span className="relative">
              <MoreHorizontal
                className={cn('size-[22px]', moreActive ? 'text-primary' : 'text-muted-foreground')}
                strokeWidth={moreActive ? 2.2 : 1.8}
                aria-hidden="true"
              />
              {needsAttention && (
                <span
                  className="bg-destructive ring-background absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className={moreActive ? LABEL_CLASSNAME_ACTIVE : LABEL_CLASSNAME_INACTIVE}>
              More
            </span>
          </button>
        </SheetTrigger>
      </nav>
      <MobileMoreSheet items={moreItems} onNavigate={() => setMoreOpen(false)} />
    </Sheet>
  );
}
