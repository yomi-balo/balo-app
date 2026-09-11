import { describe, it, expect } from 'vitest';
import { NAV_ITEM_KEYS } from '@/lib/analytics';
import {
  NAV_ENTRIES,
  resolveNavItems,
  requiresCapability,
  NO_CAPABILITY_REQUIRED,
  resolveBreadcrumbTrail,
  splitMobileNav,
  resolveMobileTabs,
  resolveMoreItems,
  MOBILE_TAB_LIMIT,
  type NavContext,
  type EnabledNavEntry,
} from './nav-registry';
import { CAPABILITIES, PLATFORM_CAPABILITIES } from '@balo/shared/authz';

/**
 * BAL-495 — registry unit tests. Deliberately does NOT re-assert the BAL-347 bottom gating
 * matrix by href/order (that lives in the rewritten `sidebar.test.ts`) — scoped apart to avoid
 * >3% new-code duplication.
 */

const COMPANY_NO_MANAGE: NavContext = { workspaceType: 'company', capabilities: [] };
const COMPANY_MANAGE: NavContext = {
  workspaceType: 'company',
  capabilities: [CAPABILITIES.MANAGE_MEMBERS],
};
const EXPERT_NO_MANAGE: NavContext = { workspaceType: 'expert', capabilities: [] };
const EXPERT_MANAGE: NavContext = {
  workspaceType: 'expert',
  capabilities: [CAPABILITIES.MANAGE_MEMBERS],
};

/**
 * BAL-534 — a staff viewer who is a PLAIN MEMBER of a PERSONAL company: holds the platform
 * token and NOT `MANAGE_MEMBERS`. That combination is the AC ("a super_admin who is a plain
 * member of a personal company sees the Balo admin group and NO Members item") and is exactly
 * what the D16 union restructure exists to make expressible.
 */
const COMPANY_STAFF: NavContext = {
  workspaceType: 'company',
  capabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
};
const EXPERT_STAFF: NavContext = {
  workspaceType: 'expert',
  capabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
};

const ALL_CONTEXTS = [
  COMPANY_NO_MANAGE,
  COMPANY_MANAGE,
  EXPERT_NO_MANAGE,
  EXPERT_MANAGE,
  COMPANY_STAFF,
  EXPERT_STAFF,
];
const DISABLED_KEYS = ['help'];

describe('NAV_ENTRIES / resolveNavItems (BAL-495)', () => {
  it('excludes disabled entries from every context, in any of the three sections', () => {
    for (const context of ALL_CONTEXTS) {
      const resolvedKeys = [
        ...resolveNavItems(context, 'primary'),
        ...resolveNavItems(context, 'secondary'),
        ...resolveNavItems(context, 'admin'),
      ].map((entry) => entry.key);
      for (const disabledKey of DISABLED_KEYS) {
        expect(resolvedKeys).not.toContain(disabledKey);
      }
    }
  });

  it('preserves NAV_ENTRIES order for the primary section despite interleaved disabled entries', () => {
    const keys = resolveNavItems(COMPANY_MANAGE, 'primary').map((entry) => entry.key);
    expect(keys).toEqual(['dashboard', 'find_experts', 'consultations', 'projects', 'messages']);
  });

  it('NAV_ENTRIES is authored primary block → secondary block → admin block (resolveMobileNav depends on it)', () => {
    const sections = NAV_ENTRIES.map((e) => e.section);
    // No 'primary' after the last 'secondary', and no 'secondary' after the last 'admin' —
    // together those two are "primary block, then secondary block, then admin block".
    expect(sections.indexOf('primary', sections.lastIndexOf('secondary'))).toBe(-1);
    expect(sections.indexOf('secondary', sections.lastIndexOf('admin'))).toBe(-1);
  });

  it('preserves NAV_ENTRIES order for the primary section in an expert context (calendar is expert-only)', () => {
    const keys = resolveNavItems(EXPERT_MANAGE, 'primary').map((entry) => entry.key);
    expect(keys).toEqual(['dashboard', 'consultations', 'projects', 'calendar', 'messages']);
  });

  it('scopes expert_settings to the expert workspace only', () => {
    expect(resolveNavItems(COMPANY_MANAGE, 'secondary').map((e) => e.key)).not.toContain(
      'expert_settings'
    );
    expect(resolveNavItems(EXPERT_MANAGE, 'secondary').map((e) => e.key)).toContain(
      'expert_settings'
    );
  });

  it('dashboard and account resolve under both workspace types; team is expert-only and settings is company-only', () => {
    expect(resolveNavItems(COMPANY_MANAGE, 'primary').map((e) => e.key)).toContain('dashboard');
    expect(resolveNavItems(EXPERT_MANAGE, 'primary').map((e) => e.key)).toContain('dashboard');
    expect(resolveNavItems(COMPANY_MANAGE, 'secondary').map((e) => e.key)).toContain('account');
    expect(resolveNavItems(EXPERT_MANAGE, 'secondary').map((e) => e.key)).toContain('account');

    // team — expert-only, regardless of capability.
    expect(resolveNavItems(EXPERT_MANAGE, 'secondary').map((e) => e.key)).toContain('team');
    expect(resolveNavItems(COMPANY_MANAGE, 'secondary').map((e) => e.key)).not.toContain('team');

    // settings — company-only, ungated.
    expect(resolveNavItems(COMPANY_MANAGE, 'secondary').map((e) => e.key)).toContain('settings');
    expect(resolveNavItems(COMPANY_NO_MANAGE, 'secondary').map((e) => e.key)).toContain('settings');
    expect(resolveNavItems(EXPERT_MANAGE, 'secondary').map((e) => e.key)).not.toContain('settings');
  });

  it('mobilePriority: exactly projects is "more" among resolved primary items; rest are "tab" in source order', () => {
    const primary = resolveNavItems(EXPERT_MANAGE, 'primary');
    const more = primary.filter((e) => e.mobilePriority === 'more').map((e) => e.key);
    const tab = primary.filter((e) => e.mobilePriority === 'tab').map((e) => e.key);
    expect(more).toEqual(['projects']);
    expect(tab).toEqual(['dashboard', 'consultations', 'calendar', 'messages']);
  });

  it('every secondary entry is mobilePriority "more"', () => {
    for (const context of ALL_CONTEXTS) {
      const secondary = resolveNavItems(context, 'secondary');
      expect(secondary.every((e) => e.mobilePriority === 'more')).toBe(true);
    }
  });

  it('badgeSource: exactly one entry has one, and it is expert_settings → expertChecklist', () => {
    const withBadge = NAV_ENTRIES.filter((e) => e.badgeSource !== undefined);
    expect(withBadge).toHaveLength(1);
    expect(withBadge[0]?.key).toBe('expert_settings');
    expect(withBadge[0]?.badgeSource).toBe('expertChecklist');
  });

  it('jumpOut: exactly one entry has it, and it is find_experts', () => {
    const withJumpOut = NAV_ENTRIES.filter((e) => e.jumpOut === true);
    expect(withJumpOut).toHaveLength(1);
    expect(withJumpOut[0]?.key).toBe('find_experts');
  });

  it('the admin section resolves for a staff context in BOTH workspace types, and for nobody else', () => {
    for (const context of [COMPANY_STAFF, EXPERT_STAFF]) {
      expect(resolveNavItems(context, 'admin').map((e) => e.key)).toEqual([
        'admin_home',
        'admin_applications',
        'admin_engagements',
        'admin_promo_codes',
        'admin_catalogue',
        'admin_health',
        'admin_lookup',
      ]);
    }
    for (const context of [COMPANY_NO_MANAGE, COMPANY_MANAGE, EXPERT_NO_MANAGE, EXPERT_MANAGE]) {
      expect(resolveNavItems(context, 'admin')).toEqual([]);
    }
  });

  it('the two capability axes gate independently: staff-without-manage sees admin and NOT Team; owner-without-staff sees Team and NOT admin', () => {
    // A super_admin who is a plain member of a personal company (expert workspace, where `team`
    // lives after BAL-503).
    expect(resolveNavItems(EXPERT_STAFF, 'admin')).toHaveLength(7);
    expect(resolveNavItems(EXPERT_STAFF, 'secondary').map((e) => e.key)).not.toContain('team');
    // A company/agency owner who is not Balo staff.
    expect(resolveNavItems(EXPERT_MANAGE, 'secondary').map((e) => e.key)).toContain('team');
    expect(resolveNavItems(EXPERT_MANAGE, 'admin')).toEqual([]);
    // Both at once.
    const both: NavContext = {
      workspaceType: 'expert',
      capabilities: [CAPABILITIES.MANAGE_MEMBERS, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    };
    expect(resolveNavItems(both, 'secondary').map((e) => e.key)).toContain('team');
    expect(resolveNavItems(both, 'admin')).toHaveLength(7);
  });

  it('every admin entry is mobilePriority "more", scoped to both workspace types, and carries no badge or jumpOut', () => {
    const admin = NAV_ENTRIES.filter((e) => e.section === 'admin');
    expect(admin).toHaveLength(7);
    for (const entry of admin) {
      expect(entry.mobilePriority).toBe('more');
      expect([...entry.workspaceTypes].sort()).toEqual(['company', 'expert']);
      expect(entry.badgeSource).toBeUndefined();
      expect(entry.jumpOut).toBeUndefined();
      expect(entry.enabled).toBe(true);
    }
  });

  it('href pins: every enabled entry matches today’s literal; help is null', () => {
    const byKey = new Map(NAV_ENTRIES.map((e) => [e.key, e]));
    expect(byKey.get('dashboard')?.href).toBe('/dashboard');
    expect(byKey.get('consultations')?.href).toBe('/consultations');
    expect(byKey.get('projects')?.href).toBe('/projects');
    expect(byKey.get('messages')?.href).toBe('/messages');
    expect(byKey.get('expert_settings')?.href).toBe('/expert/settings');
    expect(byKey.get('team')?.href).toBe('/settings/team');
    expect(byKey.get('settings')?.href).toBe('/settings');
    expect(byKey.get('account')?.href).toBe('/settings/account');
    expect(byKey.get('find_experts')?.href).toBe('/experts');
    expect(byKey.get('calendar')?.href).toBe('/expert/calendar');
    expect(byKey.get('help')?.href).toBeNull();
    expect(byKey.get('admin_home')?.href).toBe('/admin');
    expect(byKey.get('admin_applications')?.href).toBe('/admin/applications');
    expect(byKey.get('admin_engagements')?.href).toBe('/engagements');
    expect(byKey.get('admin_promo_codes')?.href).toBe('/promo-codes');
    expect(byKey.get('admin_catalogue')?.href).toBe('/admin/catalogue');
    expect(byKey.get('admin_health')?.href).toBe('/admin/health/capture');
    expect(byKey.get('admin_lookup')?.href).toBe('/admin/lookup');
  });

  it('key vocabulary is closed both ways against NAV_ITEM_KEYS', () => {
    const registryKeys = [...NAV_ENTRIES.map((e) => e.key)].sort();
    const canonicalKeys = [...NAV_ITEM_KEYS].sort();
    expect(registryKeys).toEqual(canonicalKeys);
    expect(new Set(NAV_ENTRIES.map((e) => e.key)).size).toBe(NAV_ENTRIES.length);
  });

  it('requiresCapability requires the token to be held; NO_CAPABILITY_REQUIRED is true for an empty set', () => {
    // BAL-534 — `NavCapability` is now a TWO-token union (membership `MANAGE_MEMBERS` +
    // platform `VIEW_PLATFORM_ADMIN`), so the "requires ALL tokens" `.every()` path is
    // exercised with two genuinely DIFFERENT real tokens rather than one duplicated one.
    const needsBoth = requiresCapability(
      CAPABILITIES.MANAGE_MEMBERS,
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    expect(needsBoth({ workspaceType: 'company', capabilities: [] })).toBe(false);
    expect(
      needsBoth({ workspaceType: 'company', capabilities: [CAPABILITIES.MANAGE_MEMBERS] })
    ).toBe(false);
    expect(
      needsBoth({
        workspaceType: 'company',
        capabilities: [CAPABILITIES.MANAGE_MEMBERS, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
      })
    ).toBe(true);
    expect(NO_CAPABILITY_REQUIRED({ workspaceType: 'company', capabilities: [] })).toBe(true);
  });

  it('non-vacuity: 18 declared entries, 17 enabled', () => {
    expect(NAV_ENTRIES).toHaveLength(18);
    expect(NAV_ENTRIES.filter((e) => e.enabled)).toHaveLength(17);
  });

  it('shortLabel pin: exactly dashboard/find_experts/consultations carry one', () => {
    const byKey = new Map(NAV_ENTRIES.map((e) => [e.key, e]));
    expect(byKey.get('dashboard')?.shortLabel).toBe('Home');
    expect(byKey.get('find_experts')?.shortLabel).toBe('Experts');
    expect(byKey.get('consultations')?.shortLabel).toBe('Consults');
    const withShortLabel = NAV_ENTRIES.filter((e) => e.shortLabel !== undefined).map((e) => e.key);
    expect(withShortLabel.sort()).toEqual(['consultations', 'dashboard', 'find_experts'].sort());
  });
});

/**
 * BAL-501 — the bar/sheet split. `splitMobileNav` is the pure cap+overflow rule;
 * `resolveMobileTabs`/`resolveMoreItems` are the real, context-driven callers.
 */
describe('splitMobileNav / resolveMobileTabs / resolveMoreItems (BAL-501)', () => {
  function tabEntry(key: string): EnabledNavEntry {
    return {
      key: key as EnabledNavEntry['key'],
      label: key,
      icon: NAV_ENTRIES[0]?.icon as EnabledNavEntry['icon'],
      section: 'primary',
      workspaceTypes: ['company', 'expert'],
      requires: NO_CAPABILITY_REQUIRED,
      mobilePriority: 'tab',
      enabled: true,
      href: `/${key}`,
    };
  }

  function moreEntry(key: string): EnabledNavEntry {
    return { ...tabEntry(key), mobilePriority: 'more' };
  }

  it('caps tabs at the limit; overflow entries land in moreItems at their original index', () => {
    const synthetic = [
      tabEntry('a'),
      tabEntry('b'),
      tabEntry('c'),
      tabEntry('d'),
      tabEntry('e'),
      tabEntry('f'),
    ];
    const { tabs, moreItems } = splitMobileNav(synthetic, 4);
    expect(tabs.map((e) => e.key)).toEqual(['a', 'b', 'c', 'd']);
    // Overflow ('e', 'f') is what remains AFTER subtraction — original relative order preserved,
    // not appended to a pre-existing 'more' list.
    expect(moreItems.map((e) => e.key)).toEqual(['e', 'f']);
  });

  it('overflow folds back at its registry index — a pre-existing "more" entry interleaved before the cap is NOT displaced by later overflow', () => {
    // A "filter non-tab, then concat overflow" implementation would produce
    // moreItems === ['e', 'm'] here — the same wrong shape the plan warns against. Only a true
    // subtraction (items minus the tabs Set, in original order) yields 'm' first.
    const synthetic = [
      tabEntry('a'),
      tabEntry('b'),
      moreEntry('m'),
      tabEntry('c'),
      tabEntry('d'),
      tabEntry('e'),
    ];
    const { tabs, moreItems } = splitMobileNav(synthetic, 4);
    expect(tabs.map((e) => e.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(moreItems.map((e) => e.key)).toEqual(['m', 'e']); // 'm' FIRST — overflow not appended
  });

  it('respects the default MOBILE_TAB_LIMIT when no limit is passed', () => {
    const synthetic = [tabEntry('a'), tabEntry('b'), tabEntry('c'), tabEntry('d'), tabEntry('e')];
    const { tabs } = splitMobileNav(synthetic);
    expect(tabs).toHaveLength(MOBILE_TAB_LIMIT);
  });

  it('empty input yields empty everything', () => {
    expect(splitMobileNav([])).toEqual({ tabs: [], moreItems: [] });
  });

  // ⚠ BAL-498 made the two workspace types DIVERGE here — `calendar` is expert-only and carries
  // `mobilePriority: 'tab'`, so the expert bar filled to exactly MOBILE_TAB_LIMIT (4) with no
  // overflow while company stayed at three. BAL-497 closes that gap from the other side:
  // `find_experts` is company-only and also `mobilePriority: 'tab'`, so the company bar now
  // fills to MOBILE_TAB_LIMIT too — the cap is exactly reached (not exceeded) on both sides.
  it('resolveMobileTabs today: BOTH workspace types now fill the bar to MOBILE_TAB_LIMIT', () => {
    expect(resolveMobileTabs(COMPANY_NO_MANAGE).map((e) => e.key)).toEqual([
      'dashboard',
      'find_experts',
      'consultations',
      'messages',
    ]);
    expect(resolveMobileTabs(COMPANY_NO_MANAGE)).toHaveLength(MOBILE_TAB_LIMIT);
    expect(resolveMobileTabs(EXPERT_MANAGE).map((e) => e.key)).toEqual([
      'dashboard',
      'consultations',
      'calendar',
      'messages',
    ]);
    expect(resolveMobileTabs(EXPERT_MANAGE)).toHaveLength(MOBILE_TAB_LIMIT);
  });

  it('resolveMoreItems today, by context — Projects always first (order-preserving subtraction)', () => {
    // ⚠ BAL-503 moved these numbers: it added a company-only `settings` entry and narrowed `team`
    // to the EXPERT workspace. The two company cases are now IDENTICAL — which is the executable
    // evidence that the client's More list no longer varies by capability (BAL-503 D1, and the
    // same property its own `sidebar.test.tsx` bottom-href cases pin for desktop).
    expect(resolveMoreItems(COMPANY_NO_MANAGE).map((e) => e.key)).toEqual([
      'projects',
      'settings',
      'account',
    ]);
    expect(resolveMoreItems(COMPANY_MANAGE).map((e) => e.key)).toEqual([
      'projects',
      'settings',
      'account',
    ]);
    // The expert workspace keeps `team` (BAL-503 narrowed it TO expert) and has no `settings`.
    expect(resolveMoreItems(EXPERT_MANAGE).map((e) => e.key)).toEqual([
      'projects',
      'expert_settings',
      'team',
      'account',
    ]);
  });

  it('BAL-534: the admin rows reach the More sheet for a staff context, in registry order, and nobody else’s', () => {
    expect(resolveMoreItems(COMPANY_STAFF).map((e) => e.key)).toEqual([
      'projects',
      'settings',
      'account',
      'admin_home',
      'admin_applications',
      'admin_engagements',
      'admin_promo_codes',
      'admin_catalogue',
      'admin_health',
      'admin_lookup',
    ]);
    expect(resolveMoreItems(EXPERT_STAFF).map((e) => e.key)).toEqual([
      'projects',
      'expert_settings',
      'account',
      'admin_home',
      'admin_applications',
      'admin_engagements',
      'admin_promo_codes',
      'admin_catalogue',
      'admin_health',
      'admin_lookup',
    ]);
    // …and none of them reaches the tab bar (all `'more'`; the bar is already at the cap).
    expect(resolveMobileTabs(COMPANY_STAFF).map((e) => e.key)).toEqual([
      'dashboard',
      'find_experts',
      'consultations',
      'messages',
    ]);
  });

  it('conservation: tabs + moreItems is a permutation of the primary+secondary+admin resolution, for every context', () => {
    for (const context of ALL_CONTEXTS) {
      const tabs = resolveMobileTabs(context);
      const moreItems = resolveMoreItems(context);
      const combined = [...tabs, ...moreItems].map((e) => e.key).sort();
      const expected = [
        ...resolveNavItems(context, 'primary'),
        ...resolveNavItems(context, 'secondary'),
        ...resolveNavItems(context, 'admin'),
      ]
        .map((e) => e.key)
        .sort();
      expect(combined).toEqual(expected);
    }
  });
});

/**
 * BAL-499 — the executable form of the Q1 decision: what every `(dashboard)` route's
 * breadcrumb trail resolves to. BAL-534 moved `/engagements` and `/promo-codes` into the exact
 * registry block (they are now enabled `admin`-section registry hrefs) and added
 * `/admin/catalogue`; BAL-551 added `/admin/lookup` and BAL-548 added `/admin` (the `admin_home`
 * entry): every enabled registry href gets an exact-match case below, plus a fixed set of
 * supplemental list routes and entity routes each resolving to ONLY their parent (the entity's
 * own crumb is published separately by `EntityCrumb`). `/engagements/:id` parents to Projects
 * because its list is admin-only (BAL-533).
 */
describe('resolveBreadcrumbTrail (BAL-499)', () => {
  it.each([
    // ── Exact registry hrefs ──────────────────────────────────────────────────────────────
    ['/dashboard', [{ label: 'Dashboard', href: null }]],
    ['/consultations', [{ label: 'Consultations', href: null }]],
    ['/projects', [{ label: 'Projects', href: null }]],
    ['/messages', [{ label: 'Messages', href: null }]],
    ['/expert/settings', [{ label: 'Expert Settings', href: null }]],
    // D10 regression pin — this page rendered the title "Dashboard" before BAL-499. NOT that.
    ['/settings/team', [{ label: 'Team', href: null }]],
    // BAL-503 — `/settings` always redirects, so this crumb never actually renders. Pinned
    // anyway as executable documentation.
    ['/settings', [{ label: 'Settings', href: null }]],
    // BAL-534 — now enabled `admin`-section registry hrefs (moved from supplemental below).
    ['/engagements', [{ label: 'Engagements', href: null }]],
    ['/promo-codes', [{ label: 'Promo codes', href: null }]],
    ['/admin/catalogue', [{ label: 'Config & catalogue', href: null }]],
    ['/admin/lookup', [{ label: 'Lookup', href: null }]],
    // BAL-548 — the admin Home page's own registry entry.
    ['/admin', [{ label: 'Home', href: null }]],
    // ── Supplemental (non-nav) list routes ───────────────────────────────────────────────
    ['/billing/top-up', [{ label: 'Top up', href: null }]],
    ['/redeem', [{ label: 'Redeem a code', href: null }]],
    // BAL-503 — the three new Settings sections.
    ['/settings/company', [{ label: 'Company', href: null }]],
    ['/settings/billing', [{ label: 'Credits & billing', href: null }]],
    ['/settings/notifications', [{ label: 'Notifications', href: null }]],
    // ── Entity routes — parent crumb only; the entity's own label is published separately ──
    ['/cases/case-1', [{ label: 'Consultations', href: '/consultations' }]],
    ['/meetings/meeting-1', [{ label: 'Consultations', href: '/consultations' }]],
    ['/meetings/meeting-1/end', [{ label: 'Consultations', href: '/consultations' }]],
    // BAL-533 — Projects, not Engagements: the list is admin-only and this route is project-only.
    ['/engagements/eng-1', [{ label: 'Projects', href: '/projects' }]],
    ['/projects/req-1', [{ label: 'Projects', href: '/projects' }]],
    ['/projects/req-1/proposal/rel-1', [{ label: 'Projects', href: '/projects' }]],
    // BAL-441 — the session receipt/payout pages.
    ['/sessions/session-1/receipt', [{ label: 'Consultations', href: '/consultations' }]],
    ['/sessions/session-1/payout', [{ label: 'Consultations', href: '/consultations' }]],
  ] as const)('%s resolves to %j', (pathname, expected) => {
    expect(resolveBreadcrumbTrail(pathname)).toEqual(expected);
  });

  it('unrecognised routes render no crumb — no crumb beats a wrong crumb (D11)', () => {
    expect(resolveBreadcrumbTrail('/nope')).toEqual([]);
    expect(resolveBreadcrumbTrail('/')).toEqual([]);
    expect(resolveBreadcrumbTrail('/settings/unknown')).toEqual([]);
  });

  it('BAL-499 F3: a __proto__ / constructor path segment resolves to no crumb, never an inherited Object property', () => {
    // A bare `ENTITY_PARENTS[segment]` (or `SUPPLEMENTAL_ROUTE_LABELS[pathname]`) indexes a
    // plain object literal, which resolves INHERITED keys too — `constructor` would otherwise
    // yield the `Object` constructor typed as a crumb, and `<Link href={undefined}>` would
    // throw. `Object.hasOwn` closes that off; this pins the guard rather than the bug.
    expect(resolveBreadcrumbTrail('/__proto__/anything')).toEqual([]);
    expect(resolveBreadcrumbTrail('/constructor/anything')).toEqual([]);
    expect(resolveBreadcrumbTrail('/toString/anything')).toEqual([]);
    expect(resolveBreadcrumbTrail('/valueOf/anything')).toEqual([]);
    expect(resolveBreadcrumbTrail('/constructor')).toEqual([]);
    expect(resolveBreadcrumbTrail('/toString')).toEqual([]);
  });

  it('every entity route crumb carries a non-null href (the way back is never lost)', () => {
    const entityRoutes = [
      '/cases/case-1',
      '/meetings/meeting-1',
      '/meetings/meeting-1/end',
      '/engagements/eng-1',
      '/projects/req-1',
      '/projects/req-1/proposal/rel-1',
      '/sessions/session-1/receipt',
      '/sessions/session-1/payout',
    ];
    for (const pathname of entityRoutes) {
      const [crumb] = resolveBreadcrumbTrail(pathname);
      // BAL-533 — `const [crumb] = []` is `undefined`, and `undefined.not.toBeNull()` passes;
      // this closes that vacuous-green trap for the next route removed from the table.
      expect(crumb).toBeDefined();
      expect(crumb?.href).not.toBeNull();
    }
  });

  it('every list-route crumb (exact registry or supplemental) has href: null', () => {
    const listRoutes = [
      '/dashboard',
      '/consultations',
      '/projects',
      '/messages',
      '/expert/settings',
      '/settings/team',
      '/engagements',
      '/promo-codes',
      '/admin/catalogue',
      '/admin/lookup',
      '/admin',
      '/billing/top-up',
      '/redeem',
      '/settings',
      '/settings/company',
      '/settings/billing',
      '/settings/notifications',
    ];
    for (const pathname of listRoutes) {
      const [crumb] = resolveBreadcrumbTrail(pathname);
      expect(crumb?.href).toBeNull();
    }
  });

  it('drift guard: no supplemental route collides with an enabled registry href', () => {
    const registryHrefs = new Set(NAV_ENTRIES.filter((e) => e.enabled).map((e) => e.href));
    // ⚠ Do not add '/settings' here — it IS an enabled registry href, so adding it would make
    // this drift guard fail correctly. BAL-534 removed '/engagements' and '/promo-codes' — they
    // are now enabled `admin`-section registry hrefs too.
    const supplementalRoutes = [
      '/billing/top-up',
      '/redeem',
      '/settings/company',
      '/settings/billing',
      '/settings/notifications',
    ];
    for (const route of supplementalRoutes) {
      expect(registryHrefs.has(route)).toBe(false);
    }
  });
});
