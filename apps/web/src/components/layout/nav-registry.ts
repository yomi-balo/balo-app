import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Video,
  FolderKanban,
  MessageSquare,
  Settings,
  Users,
  User,
  Search,
  CalendarDays,
  LifeBuoy,
} from 'lucide-react';
import type { Workspace } from '@balo/shared/workspaces';
import { CAPABILITIES } from '@balo/shared/authz';
import type { NavItemKey } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime

/**
 * BAL-495 — the single declarative source for the desktop sidebar, mobile bottom tabs (BAL-501)
 * and ⌘K palette (BAL-503). ADR-1053 gives all three surfaces the same destinations; this is the
 * Lane-0 shared data those surfaces consume.
 *
 * ⚠ NO `'use client'` — this module is data + pure functions, importable from both server and
 * client code. The `'use client'` boundary stays on `sidebar.tsx` / `sidebar-nav-link.tsx`.
 * ⚠ NO `server-only`, NO `@balo/db`, NO `@/lib/authz` — see `NavRequirement` below for why.
 */

/** ADR-1053 workspace the actor is acting AS. The nav SCOPING axis — never an authz input. */
export type NavWorkspaceType = Workspace['type']; // 'company' | 'expert'

/** Which of the sidebar's two `<Separator/>`-delimited groups an entry renders in. */
export type NavSection = 'primary' | 'secondary';

/** BAL-501 consumes this blind: 'tab' → bottom tab bar, 'more' → the More sheet. Inert here. */
export type NavMobilePriority = 'tab' | 'more';

/** The ONLY badge source that exists (orchestrator decision 1). No unread-messages badge. */
export type NavBadgeSource = 'expertChecklist';

/**
 * The ONLY tokens the nav grant set ever carries. Widen deliberately, one ticket at a time.
 *
 * ⚠ Deliberately NARROWER than the full membership `Capability` union. A `NavContext.capabilities`
 * typed as `readonly Capability[]` lets `ctx.capabilities.includes(CAPABILITIES.MANAGE_BILLING)`
 * compile clean and silently return `false` for a token `buildNavContext` never resolves — a
 * hidden-action bug for a future Billing entry, reachable from every client component under the
 * shell via `useSidebarOptional()`. Add a token here ONLY when `nav-context.ts` actually resolves
 * it.
 */
export type NavCapability = typeof CAPABILITIES.MANAGE_MEMBERS;

export interface NavContext {
  readonly workspaceType: NavWorkspaceType;
  /**
   * ⚠ THE NAV-SCOPED GRANT SET, NOT THE ACTOR'S REAL CAPABILITY SET. Resolved server-side by
   * `buildNavContext`, which WITHHOLDS `MANAGE_MEMBERS` on a personal company — a nav UX rule,
   * not a capability rule. Never an authorization source of truth: every gated surface still
   * hard-gates via `hasCapability` + `notFound()`. This is UX defence-in-depth.
   *
   * ⚠ ALSO STALE BY CONSTRUCTION: derived from the SESSION's `companyRole` (7-day cookie TTL),
   * not a live membership read, so it can be stale in the PERMISSIVE direction for a demoted
   * admin — the entry may render for up to 7 days after the actor lost `MANAGE_MEMBERS`. Harmless
   * today because the Team page hard-gates via `hasCapability` + `notFound()` server-side; a
   * future ticket (e.g. BAL-503) must NOT gate an ACTION on this set without its own live check.
   */
  readonly capabilities: readonly NavCapability[];
}

/** A synchronous, PURE predicate over the already-resolved context. Never async, never DB-backed. */
export type NavRequirement = (context: NavContext) => boolean;

/** Explicit "this entry has no capability gate" — every entry states its gate; none omits it. */
export const NO_CAPABILITY_REQUIRED: NavRequirement = () => true;

/** The ONE way an entry declares a capability gate. All tokens must be held. */
export function requiresCapability(...required: readonly NavCapability[]): NavRequirement {
  return (context) => required.every((capability) => context.capabilities.includes(capability));
}

interface NavEntryBase {
  readonly key: NavItemKey;
  readonly label: string;
  /** BAL-501 — the bottom-tab cell's label, when `label` itself is too long at ~10.5px in a
   *  4-or-5-column bar on a 360px viewport. Falls back to `label` when absent. Sidebar, the
   *  More sheet, and the breadcrumb `<h1>` always render `label` — never this. */
  readonly shortLabel?: string;
  readonly icon: LucideIcon;
  readonly section: NavSection;
  readonly workspaceTypes: readonly NavWorkspaceType[];
  readonly requires: NavRequirement;
  readonly mobilePriority: NavMobilePriority;
  readonly badgeSource?: NavBadgeSource;
  /** Leaves the dashboard shell (a different Next route group). Presentation only. */
  readonly jumpOut?: boolean;
}

/** An entry that renders. `href` is non-nullable HERE so a consumer never handles a null link. */
export interface EnabledNavEntry extends NavEntryBase {
  readonly enabled: true;
  readonly href: string;
}

/**
 * A placeholder that renders NOWHERE (decision 11). `href` may be null — Help has no help-centre
 * URL yet. Flipping `enabled` to `true` is therefore a TYPE ERROR until an href is supplied,
 * which is exactly the forcing function BAL-500 needs.
 */
export interface DisabledNavEntry extends NavEntryBase {
  readonly enabled: false;
  readonly href: string | null;
}

export type NavEntry = EnabledNavEntry | DisabledNavEntry;

/**
 * ⚠ Disabled entries are INTERLEAVED at their intended final positions (from
 * `.claude/design-references/balo-nav-explorer.jsx`'s `buildNav`), not appended.
 * `resolveNavItems` filters them out, so today's render order is unchanged — and BAL-497/500
 * flip one flag rather than also moving a line. The resolved order is pinned by test.
 */
export const NAV_ENTRIES: readonly NavEntry[] = [
  // ── Primary (top) section ────────────────────────────────────────────────────────────────
  {
    key: 'dashboard',
    label: 'Dashboard',
    shortLabel: 'Home',
    icon: LayoutDashboard,
    href: '/dashboard',
    section: 'primary',
    workspaceTypes: ['company', 'expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'tab',
    enabled: true,
  },

  // BAL-497 flips this on. `jumpOut` — /experts lives in the (marketing) route group.
  {
    key: 'find_experts',
    label: 'Find experts',
    shortLabel: 'Experts',
    icon: Search,
    href: '/experts',
    section: 'primary',
    workspaceTypes: ['company'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'tab',
    jumpOut: true,
    enabled: false,
  },

  {
    key: 'consultations',
    label: 'Consultations',
    shortLabel: 'Consults',
    icon: Video,
    href: '/consultations',
    section: 'primary',
    workspaceTypes: ['company', 'expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'tab',
    enabled: true,
  },

  // ⚠ THE ONE PRIMARY ENTRY DEMOTED OFF THE TAB BAR (ticket §5; prototype MOBILE_HIDDEN).
  {
    key: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    href: '/projects',
    section: 'primary',
    workspaceTypes: ['company', 'expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'more',
    enabled: true,
  },

  // BAL-497 flips this on AND must add the route — there is no (dashboard)/expert/calendar today.
  {
    key: 'calendar',
    label: 'Calendar',
    icon: CalendarDays,
    href: null,
    section: 'primary',
    workspaceTypes: ['expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'tab',
    enabled: false,
  },

  {
    key: 'messages',
    label: 'Messages',
    icon: MessageSquare,
    href: '/messages',
    section: 'primary',
    workspaceTypes: ['company', 'expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'tab',
    enabled: true,
  },

  // ── Secondary (bottom) section ───────────────────────────────────────────────────────────
  {
    key: 'expert_settings',
    label: 'Expert Settings',
    icon: Settings,
    href: '/expert/settings',
    section: 'secondary',
    workspaceTypes: ['expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'more',
    badgeSource: 'expertChecklist',
    enabled: true,
  },

  // BAL-503 — the CLIENT counterpart to `expert_settings`: one Settings destination fronting
  // Company / Team / Credits & billing / Notifications (`/settings/<section>`). Ungated at the
  // nav layer on purpose — every section either has no gate (billing, company, notifications) or
  // keeps its own live server-side gate (team, `settings/team/page.tsx`). See ADR-1029 + `:64`
  // above.
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings,
    href: '/settings',
    section: 'secondary',
    workspaceTypes: ['company'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'more',
    enabled: true,
  },

  // BAL-347: owner/admin on a NON-personal company. The personal-company half is enforced
  // SERVER-SIDE by withholding the token (`buildNavContext`) — never re-derived here.
  // BAL-503: narrowed to the EXPERT workspace only — the company client now reaches Team via
  // the `settings` entry above (`/settings/team`, a nested Settings section). `href` and
  // `requires` are unchanged — only `workspaceTypes` narrows.
  {
    key: 'team',
    label: 'Team',
    icon: Users,
    href: '/settings/team',
    section: 'secondary',
    workspaceTypes: ['expert'],
    requires: requiresCapability(CAPABILITIES.MANAGE_MEMBERS),
    mobilePriority: 'more',
    enabled: true,
  },

  {
    key: 'account',
    label: 'Account',
    icon: User,
    href: '/settings/account',
    section: 'secondary',
    workspaceTypes: ['company', 'expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'more',
    enabled: true,
  },

  // Awaits its OWN ticket to flip on and supply the help-centre URL. ⚠ NOT BAL-500: the ⌘K
  // palette shipped WITHOUT touching this entry — it resolves through the same `enabled` gate as
  // every other surface, so `help` stays absent there too. No href today — modelled honestly.
  {
    key: 'help',
    label: 'Help',
    icon: LifeBuoy,
    href: null,
    section: 'secondary',
    workspaceTypes: ['company', 'expert'],
    requires: NO_CAPABILITY_REQUIRED,
    mobilePriority: 'more',
    enabled: false,
  },
];

/**
 * A REAL type guard — `entry.enabled === true` is verified by the compiler against
 * `EnabledNavEntry` / `DisabledNavEntry`'s discriminant, unlike a user-supplied predicate body
 * (which TypeScript never checks). Applied FIRST and standalone: deleting the conjunct from an
 * inline `(entry): entry is EnabledNavEntry => entry.enabled && ...` predicate would still
 * compile, silently leaking a disabled entry — `find_experts` (a live href) into the resolved
 * list, or `href: null` (calendar/help) into `<Link>`, crashing the shell.
 */
const isEnabled = (entry: NavEntry): entry is EnabledNavEntry => entry.enabled === true;

/**
 * The ONE resolver all three surfaces share. Preserves `NAV_ENTRIES` order exactly (decision 12).
 * Four gates, in order: enabled → section → workspace scope → capability predicate.
 *
 * `entry.section === section` is a comparison on a PRESENTATION field, not an authorization
 * input. The invariant's deny-list names `role ===` / `lens` / `activeMode` / `platformRole` /
 * `companyRole` / `isPersonal` — never a bare `===`.
 */
export function resolveNavItems(
  context: NavContext,
  section: NavSection
): readonly EnabledNavEntry[] {
  return NAV_ENTRIES.filter(isEnabled).filter(
    (entry) =>
      entry.section === section &&
      entry.workspaceTypes.includes(context.workspaceType) &&
      entry.requires(context)
  );
}

/** BAL-501 — the bar's cap. At most 4 tabs + the always-present More cell = 5 columns. */
export const MOBILE_TAB_LIMIT = 4;

export interface MobileNavSplit {
  readonly tabs: readonly EnabledNavEntry[];
  readonly moreItems: readonly EnabledNavEntry[];
}

/**
 * The cap + overflow rule, over an ALREADY-RESOLVED list, in registry order.
 * Exported for test: with only 3 `'tab'` candidates enabled today the cap branch is unreachable
 * through a NavContext, and an untested `.slice()` is exactly the vacuous-AC failure the resolver
 * flagged for badges. BAL-497 makes it 4; a 5th would make it live.
 */
export function splitMobileNav(
  items: readonly EnabledNavEntry[],
  limit: number = MOBILE_TAB_LIMIT
): MobileNavSplit {
  const tabs = items.filter((entry) => entry.mobilePriority === 'tab').slice(0, limit);
  const promoted = new Set(tabs);
  return { tabs, moreItems: items.filter((entry) => !promoted.has(entry)) };
}

function resolveMobileNav(context: NavContext): MobileNavSplit {
  // `NAV_ENTRIES` is authored primary-block-then-secondary-block, so this concatenation IS
  // registry order. Pinned by test.
  return splitMobileNav([
    ...resolveNavItems(context, 'primary'),
    ...resolveNavItems(context, 'secondary'),
  ]);
}

/** BAL-501 — the bottom tab bar's resolved entries, capped at `MOBILE_TAB_LIMIT`, registry order. */
export function resolveMobileTabs(context: NavContext): readonly EnabledNavEntry[] {
  return resolveMobileNav(context).tabs;
}

/** BAL-501 — the More sheet's resolved entries: every `'more'` entry plus any tab overflow,
 *  in their original registry position (subtraction from the same ordered list — see
 *  `splitMobileNav`). */
export function resolveMoreItems(context: NavContext): readonly EnabledNavEntry[] {
  return resolveMobileNav(context).moreItems;
}

/**
 * BAL-499 — one rendered breadcrumb. `href === null` means this crumb is the current page,
 * never a link target.
 */
export interface NavCrumb {
  readonly label: string;
  readonly href: string | null;
}

/**
 * BAL-499 (D5/D11) — labels for `(dashboard)` routes that are real destinations but deliberately
 * NOT nav entries (adding them would ship unwanted sidebar/bottom-tab/⌘K items — `NAV_ENTRIES`
 * drives all three surfaces). Kept HERE rather than in the breadcrumb component so `NAV_ENTRIES`
 * still has exactly one consumer (Scan C), and so route labels have ONE home.
 */
const SUPPLEMENTAL_ROUTE_LABELS: Readonly<Record<string, string>> = {
  '/billing/top-up': 'Top up',
  '/engagements': 'Engagements',
  '/promo-codes': 'Promo codes',
  '/redeem': 'Redeem a code',
  // BAL-503 — the three NEW Settings sections. `/settings` itself and `/settings/team` are both
  // enabled registry hrefs, so `exactCrumbLabelFor` matches them first and they need no row here.
  '/settings/company': 'Company',
  '/settings/billing': 'Credits & billing',
  '/settings/notifications': 'Notifications',
};

/**
 * BAL-499 (D5/D11) — first path segment to the list an entity route sits under. The parent crumb
 * ALWAYS carries an href, so the way back is never lost even when the entity itself has
 * published no label yet.
 */
const ENTITY_PARENTS: Readonly<Record<string, NavCrumb>> = {
  cases: { label: 'Consultations', href: '/consultations' },
  meetings: { label: 'Consultations', href: '/consultations' },
  engagements: { label: 'Engagements', href: '/engagements' },
  projects: { label: 'Projects', href: '/projects' },
};

/**
 * An enabled registry entry's label for `pathname`, else the supplemental table's, else
 * `undefined`.
 *
 * ⚠ `Object.hasOwn`, NOT a bare index — `SUPPLEMENTAL_ROUTE_LABELS[pathname]` indexes a plain
 * object literal, which resolves INHERITED keys too: a `pathname` of `constructor` / `toString`
 * / `valueOf` / `__proto__` would return a non-`undefined` value, pass the `=== undefined` guard
 * in `resolveBreadcrumbTrail`, and hand a non-string to `<Link>`. Safe only incidentally today
 * because every key here starts with `/`. This repo already treats the bare-index class as a
 * defect — see the `Object.hasOwn` docblock at `meetings/[meetingId]/page.tsx:56-62`.
 */
function exactCrumbLabelFor(pathname: string): string | undefined {
  const entry = NAV_ENTRIES.filter(isEnabled).find((candidate) => candidate.href === pathname);
  if (entry !== undefined) return entry.label;
  if (!Object.hasOwn(SUPPLEMENTAL_ROUTE_LABELS, pathname)) return undefined;
  return SUPPLEMENTAL_ROUTE_LABELS[pathname];
}

/** The path's first segment (between the leading `/` and the next `/`, or the end of string). */
function firstSegmentOf(pathname: string): string {
  const [, segment] = pathname.split('/');
  return segment ?? '';
}

/**
 * BAL-499 (D5) — the route-derived crumb trail for `pathname`, deepest-last. An entity route
 * yields ONLY its parent — the entity's own crumb is published by the page (`EntityCrumb`,
 * `breadcrumb-context.tsx`) and appended by `Breadcrumbs`. An unrecognised route yields `[]`: no
 * crumb beats a wrong crumb (D11) — the old silent `'Dashboard'` fallback is gone.
 *
 * ⚠ `Object.hasOwn` guards `ENTITY_PARENTS` for the same reason as `exactCrumbLabelFor` above:
 * `firstSegmentOf` returns a bare path segment, and `constructor` / `toString` / `valueOf` /
 * `__proto__` are all reachable inputs once ANY `(dashboard)/[slug]` catch-all route exists. Not
 * reachable today (no such route), but this repo treats the class as a defect regardless of
 * reachability (see the docblock above).
 */
export function resolveBreadcrumbTrail(pathname: string): readonly NavCrumb[] {
  const exact = exactCrumbLabelFor(pathname);
  if (exact !== undefined) return [{ label: exact, href: null }];
  const segment = firstSegmentOf(pathname);
  if (!Object.hasOwn(ENTITY_PARENTS, segment)) return [];
  const parent = ENTITY_PARENTS[segment];
  return parent === undefined ? [] : [parent];
}
