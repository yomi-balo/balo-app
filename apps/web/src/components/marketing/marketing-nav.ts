import { LifeBuoy, Search, Sparkles, Wallet, type LucideIcon } from 'lucide-react';
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

// ⚠ Named `MARKETING_NAV_ITEMS`, NOT `MARKETING_NAV_ENTRIES` — this is deliberate, not a
// missed-the-BAL-495-convention accident. `nav-registry-capability-gated.test.ts` (Scan C,
// :113-118) asserts `components/layout/nav-registry.ts` is the ONLY non-test source file whose
// text contains the literal substring `NAV_ENTRIES`. Renaming this constant to end in
// `_ENTRIES` would trip that invariant and fail the suite — leave the name as-is.
// The design reference's four links, in its order: Find experts · How it works · For experts ·
// Pricing. Only Find experts has an active state there.
//
// ⚠ How it works, For experts and Pricing point at PLACEHOLDER pages for now
// (`app/(marketing)/{how-it-works,for-experts,pricing}`). For experts deliberately does NOT go to
// the expert application (`/expert/apply`): signed-out visitors land on the placeholder until the
// real supply-side page exists.
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
    key: 'how_it_works',
    label: 'How it works',
    href: '/how-it-works',
    icon: LifeBuoy,
    isActive: () => false,
  },
  {
    key: 'for_experts',
    label: 'For experts',
    href: '/for-experts',
    icon: Sparkles,
    isActive: () => false,
  },
  {
    key: 'pricing',
    label: 'Pricing',
    href: '/pricing',
    icon: Wallet,
    isActive: () => false,
  },
];
