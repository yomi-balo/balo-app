import type { LucideIcon } from 'lucide-react';
import { Building2, Users, Wallet, Bell } from 'lucide-react';
import type { SettingsSection } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime

/**
 * BAL-503 — the client Settings surface's ordered section vocabulary. PURE, no imports from
 * `@balo/db` / `server-only` — safe to import from both the server layout and the client tab bar.
 *
 * `key` is typed from `SettingsSection` (`@balo/analytics`'s canonical tuple), so a rendered tab,
 * a URL segment under `/settings/<section>`, and an analytics `section` value cannot drift apart —
 * the same discipline as `NAV_ITEM_KEYS`.
 */
export interface SettingsSectionMeta {
  readonly key: SettingsSection;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** True only for `team` — the one section whose tab is capability-gated. */
  readonly requiresManageMembers: boolean;
}

/** Design-reference order (`balo-nav-explorer.jsx:192`). The tab bar renders this verbatim. */
export const SETTINGS_SECTION_ORDER: readonly SettingsSectionMeta[] = [
  {
    key: 'company',
    label: 'Company',
    href: '/settings/company',
    icon: Building2,
    requiresManageMembers: false,
  },
  {
    key: 'team',
    label: 'Team',
    href: '/settings/team',
    icon: Users,
    requiresManageMembers: true,
  },
  {
    key: 'billing',
    label: 'Credits & billing',
    href: '/settings/billing',
    icon: Wallet,
    requiresManageMembers: false,
  },
  {
    key: 'notifications',
    label: 'Notifications',
    href: '/settings/notifications',
    icon: Bell,
    requiresManageMembers: false,
  },
];

/** The section keys as a Set — membership test, never a bare object index (no proto hazard). */
const SECTION_KEYS = new Set<string>(SETTINGS_SECTION_ORDER.map((section) => section.key));

/**
 * `/settings/billing` → `'billing'`; `/settings`, `/settings/account`, `/settings/__proto__` →
 * `null`. Reads path segment index 2 (`''`, `'settings'`, `'<section>'`, …) and tests it against a
 * `Set` — never a regex (SonarCloud S5852) and never a bare object index (the `__proto__` /
 * `constructor` prototype-pollution class `nav-registry.ts:317-322` documents).
 */
export function resolveActiveSection(pathname: string): SettingsSection | null {
  const parts = pathname.split('/');
  // noUncheckedIndexedAccess: destructure + guard, never `!`.
  // `root` is asserted to be `'settings'` so this function enforces the contract it documents —
  // without it `/expert/settings/billing` resolves to `'billing'`. Unreachable from today's only
  // caller (mounted inside `settings/layout.tsx`), but the function is exported and pure, so the
  // next caller would inherit the looser behaviour silently.
  const [, root, segment] = parts;
  if (root !== 'settings' || segment === undefined || !SECTION_KEYS.has(segment)) {
    return null;
  }
  return segment as SettingsSection;
}
