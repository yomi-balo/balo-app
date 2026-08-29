import { describe, it, expect } from 'vitest';
import { NAV_ITEM_KEYS } from '@/lib/analytics';
import {
  NAV_ENTRIES,
  resolveNavItems,
  requiresCapability,
  NO_CAPABILITY_REQUIRED,
  resolveBreadcrumbTrail,
  type NavContext,
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
const DISABLED_KEYS = ['find_experts', 'calendar', 'help'];

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
    expect(keys).toEqual(['dashboard', 'consultations', 'projects', 'messages']);
  });

  it('scopes expert_settings to the expert workspace only', () => {
    expect(resolveNavItems(COMPANY_MANAGE, 'secondary').map((e) => e.key)).not.toContain(
      'expert_settings'
    );
    expect(resolveNavItems(EXPERT_MANAGE, 'secondary').map((e) => e.key)).toContain(
      'expert_settings'
    );
  });

  it('dashboard, team (when granted), and account resolve under both workspace types', () => {
    for (const [companyCtx, expertCtx] of [[COMPANY_MANAGE, EXPERT_MANAGE]] as const) {
      expect(resolveNavItems(companyCtx, 'primary').map((e) => e.key)).toContain('dashboard');
      expect(resolveNavItems(expertCtx, 'primary').map((e) => e.key)).toContain('dashboard');
      expect(resolveNavItems(companyCtx, 'secondary').map((e) => e.key)).toContain('team');
      expect(resolveNavItems(expertCtx, 'secondary').map((e) => e.key)).toContain('team');
      expect(resolveNavItems(companyCtx, 'secondary').map((e) => e.key)).toContain('account');
      expect(resolveNavItems(expertCtx, 'secondary').map((e) => e.key)).toContain('account');
    }
  });

  it('mobilePriority: exactly projects is "more" among resolved primary items; rest are "tab" in source order', () => {
    const primary = resolveNavItems(EXPERT_MANAGE, 'primary');
    const more = primary.filter((e) => e.mobilePriority === 'more').map((e) => e.key);
    const tab = primary.filter((e) => e.mobilePriority === 'tab').map((e) => e.key);
    expect(more).toEqual(['projects']);
    expect(tab).toEqual(['dashboard', 'consultations', 'messages']);
  });

  it('every secondary entry is mobilePriority "more"', () => {
    const secondary = resolveNavItems(EXPERT_MANAGE, 'secondary');
    expect(secondary.every((e) => e.mobilePriority === 'more')).toBe(true);
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

  it('href pins: every enabled entry matches today’s literal; calendar and help are null', () => {
    const byKey = new Map(NAV_ENTRIES.map((e) => [e.key, e]));
    expect(byKey.get('dashboard')?.href).toBe('/dashboard');
    expect(byKey.get('consultations')?.href).toBe('/consultations');
    expect(byKey.get('projects')?.href).toBe('/projects');
    expect(byKey.get('messages')?.href).toBe('/messages');
    expect(byKey.get('expert_settings')?.href).toBe('/expert/settings');
    expect(byKey.get('team')?.href).toBe('/settings/team');
    expect(byKey.get('account')?.href).toBe('/settings/account');
    expect(byKey.get('find_experts')?.href).toBe('/experts');
    expect(byKey.get('calendar')?.href).toBeNull();
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

  it('non-vacuity: 10 declared entries, 7 enabled', () => {
    expect(NAV_ENTRIES.length).toBe(10);
    expect(NAV_ENTRIES.filter((e) => e.enabled).length).toBe(7);
  });
});

/**
 * BAL-499 — the executable form of the Q1 decision: what every `(dashboard)` route's
 * breadcrumb trail resolves to. 16 routes total (recounted from the resolver's "9 of 16" — see
 * the plan's Q1 and orchestrator ruling R1): 6 have an exact registry `href`, 4 are supplemental
 * list routes, 6 are entity routes (each resolving to ONLY its parent — the entity's own crumb
 * is published separately by `EntityCrumb`).
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
    // ── Supplemental (non-nav) list routes ───────────────────────────────────────────────
    ['/billing/top-up', [{ label: 'Top up', href: null }]],
    ['/engagements', [{ label: 'Engagements', href: null }]],
    ['/promo-codes', [{ label: 'Promo codes', href: null }]],
    ['/redeem', [{ label: 'Redeem a code', href: null }]],
    // ── Entity routes — parent crumb only; the entity's own label is published separately ──
    ['/cases/case-1', [{ label: 'Consultations', href: '/consultations' }]],
    ['/meetings/meeting-1', [{ label: 'Consultations', href: '/consultations' }]],
    ['/meetings/meeting-1/end', [{ label: 'Consultations', href: '/consultations' }]],
    ['/engagements/eng-1', [{ label: 'Engagements', href: '/engagements' }]],
    ['/projects/req-1', [{ label: 'Projects', href: '/projects' }]],
    ['/projects/req-1/proposal/rel-1', [{ label: 'Projects', href: '/projects' }]],
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
    ];
    for (const pathname of listRoutes) {
      const [crumb] = resolveBreadcrumbTrail(pathname);
      expect(crumb?.href).toBeNull();
    }
  });

  it('drift guard: no supplemental route collides with an enabled registry href', () => {
    const registryHrefs = new Set(NAV_ENTRIES.filter((e) => e.enabled).map((e) => e.href));
    const supplementalRoutes = ['/billing/top-up', '/engagements', '/promo-codes', '/redeem'];
    for (const route of supplementalRoutes) {
      expect(registryHrefs.has(route)).toBe(false);
    }
  });
});
