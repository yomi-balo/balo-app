'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Menu } from 'lucide-react';
import { Logo } from '@/components/layout/logo';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { NotificationBell } from '@/components/balo/notification-bell';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { cn } from '@/lib/utils';
import { isMarketingHomePath } from '@/lib/marketing/is-marketing-home-path';
import type { MarketingNavLink } from '@/lib/analytics';
import { MARKETING_NAV_ITEMS } from './marketing-nav';
import { MarketingMobileMenu } from './marketing-mobile-menu';
import { useMarketingTracking } from './use-marketing-tracking';
import type { MarketingViewer } from './marketing-viewer';

interface MarketingHeaderProps {
  /** `null` for a signed-out visitor. `viewer !== null` IS the signed-in signal — there is no
   * separate `isLoggedIn` boolean. */
  viewer: MarketingViewer | null;
}

/** Scroll depth (px) past which the home hero header switches from transparent to frosted. */
const SCROLL_GLASS_THRESHOLD_PX = 24;

/**
 * BAL-493 / D3 §9.3 — page-aware transparent → frosted. Only `/` has a hero to sit
 * transparently over; every other marketing route (`/experts`, `/experts/{username}`) keeps
 * today's frosted appearance at all times — the pre-BAL-493 default. `overHero` gates whether
 * the scroll listener is installed at all (nothing to observe off `/`), and the effect handles
 * the browser-back-restores-scroll-position case by reading `scrollY` once on mount.
 */
function useHeaderGlass(pathname: string): boolean {
  const overHero = isMarketingHomePath(pathname);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!overHero) {
      setScrolled(false);
      return;
    }

    let raf = 0;
    const readScroll = (): void => {
      setScrolled(globalThis.scrollY > SCROLL_GLASS_THRESHOLD_PX);
    };
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = globalThis.requestAnimationFrame(() => {
        raf = 0;
        readScroll();
      });
    };

    readScroll();
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      globalThis.removeEventListener('scroll', onScroll);
      if (raf !== 0) globalThis.cancelAnimationFrame(raf);
    };
  }, [overHero]);

  return !overHero || scrolled;
}

/**
 * BAL-502 — the `(marketing)` route group's header. Owns the mobile sheet's open state and
 * the auth-modal wiring; the signed-in/signed-out branch is decided entirely by `viewer`,
 * which the server layout already resolved (Decision 1 — no client session probe here).
 */
export function MarketingHeader({ viewer }: Readonly<MarketingHeaderProps>): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const authModal = useAuthModal();
  const headerTracking = useMarketingTracking('header');
  const mobileTracking = useMarketingTracking('mobile_menu');
  const glass = useHeaderGlass(pathname);

  const handleOpenMenu = useCallback(() => setMenuOpen(true), []);

  // `router.refresh()` re-runs the server layout, which re-reads the session and swaps the
  // header to the signed-in variant — the whole "swap" mechanism is server-driven.
  const handleLogIn = useCallback(() => {
    authModal.open({ onSuccess: () => router.refresh() });
  }, [authModal, router]);

  const handleDashboardClick = useCallback(() => {
    headerTracking.dashboardClicked();
  }, [headerTracking]);

  const handleNavClick = useCallback(
    (link: MarketingNavLink) => () => {
      headerTracking.navClicked(link);
    },
    [headerTracking]
  );

  // The mobile sheet closes itself before invoking these (marketing-mobile-menu.tsx); only the
  // tracking + auth-modal wiring lives here so both surfaces share one dispatch point.
  const handleMobileNavigate = useCallback(
    (link: MarketingNavLink) => mobileTracking.navClicked(link),
    [mobileTracking]
  );
  const handleMobileDashboard = useCallback(
    () => mobileTracking.dashboardClicked(),
    [mobileTracking]
  );
  const handleMobileLogIn = useCallback(() => {
    authModal.open({ onSuccess: () => router.refresh() });
  }, [authModal, router]);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full border-b transition-colors motion-reduce:transition-none',
        glass
          ? 'border-border bg-background/90 supports-[backdrop-filter]:bg-background/70 backdrop-blur'
          : 'border-transparent bg-transparent'
      )}
    >
      {/* BAL-502 FIX round — `lg:px-8` (32px) vs the prototype's flat `padding: '0 40px'` is a
          deliberate scale-down, not a missed pixel: CLAUDE.md's own "Content padding" table
          (and 10 other call sites in this app) standardize on `px-4 sm:px-6 lg:px-8`, and the
          marketing header follows that shared responsive scale rather than a one-off 40px. */}
      <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-4 px-4 sm:px-6 md:h-16 md:gap-9 lg:px-8">
        <Logo />
        <nav aria-label="Marketing" className="hidden items-center gap-[26px] md:flex">
          {MARKETING_NAV_ITEMS.map((entry) => {
            const isActive = entry.isActive(pathname);
            return (
              <Link
                key={entry.key}
                href={entry.href}
                aria-current={isActive ? 'page' : undefined}
                onClick={handleNavClick(entry.key)}
                className={cn(
                  'text-[13.5px] font-medium transition-colors motion-reduce:transition-none',
                  isActive
                    ? 'text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {entry.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {viewer ? (
            <>
              <NotificationBell />
              <Button
                asChild
                variant="outline"
                size="sm"
                className="hidden md:inline-flex"
                onClick={handleDashboardClick}
              >
                <Link href="/dashboard">
                  <LayoutDashboard className="size-3.5" />
                  Dashboard
                </Link>
              </Button>
              <Link
                href="/dashboard"
                aria-label={`Go to your dashboard, ${viewer.displayName}`}
                onClick={handleDashboardClick}
                className="focus-visible:ring-ring flex size-11 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none md:size-9"
              >
                <Avatar className="size-8">
                  {viewer.avatarUrl && <AvatarImage src={viewer.avatarUrl} alt="" />}
                  <AvatarFallback className="from-primary bg-gradient-to-br to-violet-600 text-xs font-semibold text-white">
                    {viewer.initials}
                  </AvatarFallback>
                </Avatar>
              </Link>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-9"
                onClick={handleLogIn}
              >
                Log in
              </Button>
              {/* BAL-493 / D3 — "Find an expert" replaces "Get started". A plain destination
                  link, not a conversion action: no tracking dispatch (§9.2), solid `--primary`
                  with white `--primary-foreground` text (never the `gradient` variant, which
                  is reserved for the hero submit / spotlight / final-band CTAs). */}
              <Button asChild size="sm" className="hidden md:inline-flex">
                <Link href="/experts">Find an expert</Link>
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={handleOpenMenu}
          >
            <Menu className="size-5" />
          </Button>
        </div>
      </div>
      <MarketingMobileMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        viewer={viewer}
        onNavigate={handleMobileNavigate}
        onDashboard={handleMobileDashboard}
        onLogIn={handleMobileLogIn}
      />
    </header>
  );
}
