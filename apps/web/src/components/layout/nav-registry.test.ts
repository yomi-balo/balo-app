import { describe, it, expect } from 'vitest';
import { NAV_ITEM_KEYS } from '@/lib/analytics';
import {
  NAV_ENTRIES,
  resolveNavItems,
  requiresCapability,
  NO_CAPABILITY_REQUIRED,
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
