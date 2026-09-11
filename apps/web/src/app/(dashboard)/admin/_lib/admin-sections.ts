import type { LucideIcon } from 'lucide-react';
import { Inbox, Layers } from 'lucide-react';

/**
 * BAL-548 (folded from the BAL-534 / PR #285 review, item 1) — the `/admin/*` chip sub-nav's
 * ordered section vocabulary. PURE, no `@balo/db`, no `server-only` — safe to import from both
 * the server `layout.tsx` and the client `admin-section-nav.tsx`. Mirrors
 * `settings/_lib/settings-sections.ts`'s shape verbatim (BAL-503).
 *
 * ⚠ ONLY TWO CHIPS. `Engagements` and `Promo codes` are `admin`-section NAV_ENTRIES (the Balo
 * admin sidebar/More-sheet group), but they live at `/engagements` and `/promo-codes` —
 * OUTSIDE `/admin/*` — so they are not chips here. This sub-nav covers only the routes actually
 * nested under the `(dashboard)/admin` layout: Home (`/admin`) and Config & catalogue
 * (`/admin/catalogue`).
 */
export interface AdminSectionMeta {
  readonly key: 'home' | 'catalogue';
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
}

export type AdminSectionKey = AdminSectionMeta['key'];

/** Design-reference order (`admin-home.jsx`'s `ADMIN_NAV`). Home first. */
export const ADMIN_SECTION_ORDER: readonly AdminSectionMeta[] = [
  { key: 'home', label: 'Home', href: '/admin', icon: Inbox },
  { key: 'catalogue', label: 'Config & catalogue', href: '/admin/catalogue', icon: Layers },
];

const SECTION_KEYS = new Set<string>(ADMIN_SECTION_ORDER.map((section) => section.key));

/**
 * `/admin` → `'home'`; `/admin/catalogue` → `'catalogue'`; anything else (including
 * `/admin/__proto__`, `/settings/admin`) → `null`. Segment index 2 tested against a `Set` —
 * never a regex (SonarCloud S5852) and never a bare object index (the `__proto__` /
 * `constructor` prototype-pollution class `nav-registry.ts:317-322` documents).
 */
export function resolveActiveAdminSection(pathname: string): AdminSectionKey | null {
  const parts = pathname.split('/');
  const [, root, segment] = parts;
  if (root !== 'admin') return null;
  if (segment === undefined) return 'home';
  return SECTION_KEYS.has(segment) ? (segment as AdminSectionKey) : null;
}
