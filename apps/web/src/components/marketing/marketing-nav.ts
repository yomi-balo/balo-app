import { Search, Sparkles, type LucideIcon } from 'lucide-react';
import type { MarketingNavLink } from '@/lib/analytics';

export interface MarketingNavEntry {
  /** ⚠ Typed from `MARKETING_NAV_LINKS` so the link and its analytics value cannot drift. */
  key: MarketingNavLink;
  label: string;
  href: string;
  /** Mobile sheet only — the desktop bar is text-only, per the design reference. */
  icon: LucideIcon;
  /** Desktop active-state predicate, evaluated against `usePathname()`. */
  isActive: (pathname: string) => boolean;
}

export const MARKETING_NAV_ITEMS: readonly MarketingNavEntry[] = [
  {
    key: 'find_experts',
    label: 'Find experts',
    href: '/experts',
    icon: Search,
    // The design reference keeps this highlighted on the profile page too
    // (`page === 'experts' || page === 'expertProfile'`).
    isActive: (pathname) => pathname === '/experts' || pathname.startsWith('/experts/'),
  },
  {
    key: 'for_experts',
    label: 'For experts',
    href: '/expert/apply',
    icon: Sparkles,
    // The design reference gives this no active state.
    isActive: () => false,
  },
];

// TODO(MJ — final link set is an MJ decision): the design reference specifies FOUR links, in
// this order: Find experts · How it works · For experts · Pricing. `how_it_works` (icon
// LifeBuoy) and `pricing` (icon Wallet) are omitted because neither page exists. Their keys are
// already declared in `MARKETING_NAV_LINKS`, so adding them here later needs no analytics change.
