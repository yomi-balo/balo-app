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

  // BAL-347: owner/admin on a NON-personal company. The personal-company half is enforced
  // SERVER-SIDE by withholding the token (`buildNavContext`) — never re-derived here.
  {
    key: 'team',
    label: 'Team',
    icon: Users,
    href: '/settings/team',
    section: 'secondary',
    workspaceTypes: ['company', 'expert'],
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

  // BAL-500 flips this on and supplies the help-centre URL. No href today — modelled honestly.
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
