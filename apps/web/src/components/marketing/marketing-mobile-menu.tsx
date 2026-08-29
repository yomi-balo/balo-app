'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { LayoutDashboard, type LucideIcon } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MarketingNavLink } from '@/lib/analytics';
import { MARKETING_NAV_ITEMS } from './marketing-nav';
import type { MarketingViewer } from './marketing-viewer';

interface MarketingMobileMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewer: MarketingViewer | null;
  onNavigate: (link: MarketingNavLink) => void;
  onDashboard: () => void;
  onGetStarted: () => void;
  onLogIn: () => void;
}

interface MobileMenuItemProps {
  icon: LucideIcon;
  label: string;
  href?: string;
  onSelect: () => void;
}

const MENU_ITEM_CLASS = cn(
  // BAL-502 FIX round — `motion-reduce:transition-none` was already present on the desktop nav
  // link (`marketing-header.tsx`); it was missing here.
  'flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-[15px] font-medium transition-colors motion-reduce:transition-none',
  'text-foreground hover:bg-accent',
  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
);

/** Small local sub-component — a nav/action row in the sheet. Uses `next/link` when it has an href. */
function MobileMenuItem({
  icon: Icon,
  label,
  href,
  onSelect,
}: Readonly<MobileMenuItemProps>): React.JSX.Element {
  if (href) {
    return (
      <Link href={href} className={MENU_ITEM_CLASS} onClick={onSelect}>
        <Icon className="size-[18px]" />
        {label}
      </Link>
    );
  }

  return (
    <button type="button" className={MENU_ITEM_CLASS} onClick={onSelect}>
      <Icon className="size-[18px]" />
      {label}
    </button>
  );
}

/**
 * BAL-502 — the mobile bottom sheet menu. Fully controlled by the header, which owns the
 * open/closed state.
 *
 * ⚠ Every item closes the sheet BEFORE running its action — mandatory, not stylistic: on
 * mobile the auth modal is itself a bottom sheet (`auth-modal.tsx`), and two stacked bottom
 * sheets is a focus-trap collision.
 *
 * Not built: the prototype's `Messages` sheet item (`badge={3}`) — no unread-count data
 * source exists (BAL-495 shipped none), and the destination belongs to the dashboard nav
 * registry, not marketing chrome.
 */
export function MarketingMobileMenu({
  open,
  onOpenChange,
  viewer,
  onNavigate,
  onDashboard,
  onGetStarted,
  onLogIn,
}: Readonly<MarketingMobileMenuProps>): React.JSX.Element {
  const handleNavigate = useCallback(
    (link: MarketingNavLink) => () => {
      onOpenChange(false);
      onNavigate(link);
    },
    [onOpenChange, onNavigate]
  );

  const handleDashboard = useCallback(() => {
    onOpenChange(false);
    onDashboard();
  }, [onOpenChange, onDashboard]);

  const handleGetStarted = useCallback(() => {
    onOpenChange(false);
    onGetStarted();
  }, [onOpenChange, onGetStarted]);

  const handleLogIn = useCallback(() => {
    onOpenChange(false);
    onLogIn();
  }, [onOpenChange, onLogIn]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl px-3 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] data-[state=open]:duration-300"
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        {MARKETING_NAV_ITEMS.map((entry) => (
          <MobileMenuItem
            key={entry.key}
            icon={entry.icon}
            label={entry.label}
            href={entry.href}
            onSelect={handleNavigate(entry.key)}
          />
        ))}
        <div className="border-border mt-1.5 mb-3 border-t" />
        {viewer ? (
          <MobileMenuItem
            icon={LayoutDashboard}
            label="Dashboard"
            href="/dashboard"
            onSelect={handleDashboard}
          />
        ) : (
          <div className="flex flex-col gap-2 px-1">
            <Button variant="gradient" size="lg" className="w-full" onClick={handleGetStarted}>
              Get started
            </Button>
            <Button variant="outline" size="lg" className="w-full" onClick={handleLogIn}>
              Log in
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
