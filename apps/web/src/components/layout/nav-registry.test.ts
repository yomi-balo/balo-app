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
import { CAPABILITIES } from '@balo/shared/authz';

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

const ALL_CONTEXTS = [COMPANY_NO_MANAGE, COMPANY_MANAGE, EXPERT_NO_MANAGE, EXPERT_MANAGE];
const DISABLED_KEYS = ['help'];

describe('NAV_ENTRIES / resolveNavItems (BAL-495)', () => {
  it('excludes disabled entries from every context, in either section (AC #2)', () => {
    for (const context of ALL_CONTEXTS) {
      const resolvedKeys = [
        ...resolveNavItems(context, 'primary'),
        ...resolveNavItems(context, 'secondary'),
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

  it('NAV_ENTRIES is authored as one primary block then one secondary block (resolveMobileNav depends on it)', () => {
    const sections = NAV_ENTRIES.map((e) => e.section);
    expect(sections.indexOf('primary', sections.lastIndexOf('secondary'))).toBe(-1);
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
  });

  it('key vocabulary is closed both ways against NAV_ITEM_KEYS', () => {
    const registryKeys = [...NAV_ENTRIES.map((e) => e.key)].sort();
    const canonicalKeys = [...NAV_ITEM_KEYS].sort();
    expect(registryKeys).toEqual(canonicalKeys);
    expect(new Set(NAV_ENTRIES.map((e) => e.key)).size).toBe(NAV_ENTRIES.length);
  });

  it('requiresCapability requires the token to be held; NO_CAPABILITY_REQUIRED is true for an empty set', () => {
    // `NavCapability` is deliberately closed to `MANAGE_MEMBERS` alone (fix round #1), so the
    // "requires ALL tokens" `.every()` path is exercised with a duplicated real token rather
    // than a second capability the registry doesn't carry — the vocabulary must not widen just
    // to serve this test.
    const needsToken = requiresCapability(CAPABILITIES.MANAGE_MEMBERS, CAPABILITIES.MANAGE_MEMBERS);
    expect(needsToken({ workspaceType: 'company', capabilities: [] })).toBe(false);
    expect(
      needsToken({ workspaceType: 'company', capabilities: [CAPABILITIES.MANAGE_MEMBERS] })
    ).toBe(true);
    expect(NO_CAPABILITY_REQUIRED({ workspaceType: 'company', capabilities: [] })).toBe(true);
  });

  it('non-vacuity: 11 declared entries, 10 enabled', () => {
    expect(NAV_ENTRIES).toHaveLength(11);
    expect(NAV_ENTRIES.filter((e) => e.enabled)).toHaveLength(10);
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

  it('conservation: tabs + moreItems is a permutation of the primary+secondary resolution, for every context', () => {
    for (const context of ALL_CONTEXTS) {
      const tabs = resolveMobileTabs(context);
      const moreItems = resolveMoreItems(context);
      const combined = [...tabs, ...moreItems].map((e) => e.key).sort();
      const expected = [
        ...resolveNavItems(context, 'primary'),
        ...resolveNavItems(context, 'secondary'),
      ]
        .map((e) => e.key)
        .sort();
      expect(combined).toEqual(expected);
    }
  });
});

/**
 * BAL-499 — the executable form of the Q1 decision: what every `(dashboard)` route's
 * breadcrumb trail resolves to. 20 routes total (BAL-503 adds `/settings`, `/settings/company`,
 * `/settings/billing`, `/settings/notifications`): 7 have an exact registry `href`, 7 are
 * supplemental list routes, 6 are entity routes (each resolving to ONLY its parent — the
 * entity's own crumb is published separately by `EntityCrumb`).
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
    // ── Supplemental (non-nav) list routes ───────────────────────────────────────────────
    ['/billing/top-up', [{ label: 'Top up', href: null }]],
    ['/engagements', [{ label: 'Engagements', href: null }]],
    ['/promo-codes', [{ label: 'Promo codes', href: null }]],
    ['/redeem', [{ label: 'Redeem a code', href: null }]],
    // BAL-503 — the three new Settings sections.
    ['/settings/company', [{ label: 'Company', href: null }]],
    ['/settings/billing', [{ label: 'Credits & billing', href: null }]],
    ['/settings/notifications', [{ label: 'Notifications', href: null }]],
    // ── Entity routes — parent crumb only; the entity's own label is published separately ──
    ['/cases/case-1', [{ label: 'Consultations', href: '/consultations' }]],
    ['/meetings/meeting-1', [{ label: 'Consultations', href: '/consultations' }]],
    ['/meetings/meeting-1/end', [{ label: 'Consultations', href: '/consultations' }]],
    ['/engagements/eng-1', [{ label: 'Engagements', href: '/engagements' }]],
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
    ];
    for (const pathname of entityRoutes) {
      const [crumb] = resolveBreadcrumbTrail(pathname);
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
      '/billing/top-up',
      '/engagements',
      '/promo-codes',
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
    // this drift guard fail correctly.
    const supplementalRoutes = [
      '/billing/top-up',
      '/engagements',
      '/promo-codes',
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
