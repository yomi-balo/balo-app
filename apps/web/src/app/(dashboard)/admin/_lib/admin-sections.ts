import type { LucideIcon } from 'lucide-react';
import { Inbox, Layers, ScanSearch, UserPlus } from 'lucide-react';

/**
 * BAL-548 (folded from the BAL-534 / PR #285 review, item 1) — the `/admin/*` chip sub-nav's
 * ordered section vocabulary. PURE, no `@balo/db`, no `server-only` — safe to import from both
 * the server `layout.tsx` and the client `admin-section-nav.tsx`. Mirrors
 * `settings/_lib/settings-sections.ts`'s shape verbatim (BAL-503).
 *
 * ⚠ FOUR CHIPS, AND THE SET IS "ROUTES NESTED UNDER `(dashboard)/admin`" — NOT "the Balo admin
 * nav group". `Engagements` and `Promo codes` ARE `admin`-section NAV_ENTRIES but live at
 * `/engagements` and `/promo-codes`, OUTSIDE `/admin/*`, so they are not chips here.
 * BAL-551 shipped `/admin/lookup` WITHOUT a chip — a one-line gap this ticket closes alongside
 * its own `applications` chip (orchestrator ruling), so the rule and the list finally agree.
 */
export interface AdminSectionMeta {
  readonly key: 'home' | 'applications' | 'lookup' | 'catalogue';
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
}

export type AdminSectionKey = AdminSectionMeta['key'];

/** Design-reference order (`admin-home.jsx`'s `ADMIN_NAV`). Home first; config last. */
export const ADMIN_SECTION_ORDER: readonly AdminSectionMeta[] = [
  { key: 'home', label: 'Home', href: '/admin', icon: Inbox },
  { key: 'applications', label: 'Applications', href: '/admin/applications', icon: UserPlus },
  { key: 'lookup', label: 'Lookup', href: '/admin/lookup', icon: ScanSearch },
  { key: 'catalogue', label: 'Config & catalogue', href: '/admin/catalogue', icon: Layers },
];

const SECTION_KEYS = new Set<string>(ADMIN_SECTION_ORDER.map((section) => section.key));

/**
 * `/admin` → `'home'`; `/admin/catalogue` → `'catalogue'`; `/admin/applications/{id}` →
 * `'applications'` (segment index 2 only — the detail route's id is never inspected); anything
 * else (including `/admin/__proto__`, `/settings/admin`) → `null`. Segment index 2 tested
 * against a `Set` — never a regex (SonarCloud S5852) and never a bare object index (the
 * `__proto__` / `constructor` prototype-pollution class `nav-registry.ts:317-322` documents).
 */
export function resolveActiveAdminSection(pathname: string): AdminSectionKey | null {
  const parts = pathname.split('/');
  const [, root, segment] = parts;
  if (root !== 'admin') return null;
  if (segment === undefined) return 'home';
  return SECTION_KEYS.has(segment) ? (segment as AdminSectionKey) : null;
}
