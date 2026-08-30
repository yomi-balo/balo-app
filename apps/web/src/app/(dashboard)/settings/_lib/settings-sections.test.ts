import { describe, it, expect } from 'vitest';
import { SETTINGS_SECTIONS } from '@/lib/analytics';
import { SETTINGS_SECTION_ORDER, resolveActiveSection } from './settings-sections';

describe('SETTINGS_SECTION_ORDER', () => {
  it('key set is closed both ways against SETTINGS_SECTIONS', () => {
    const orderKeys = [...SETTINGS_SECTION_ORDER.map((s) => s.key)].sort();
    const canonicalKeys = [...SETTINGS_SECTIONS].sort();
    expect(orderKeys).toEqual(canonicalKeys);
    expect(new Set(SETTINGS_SECTION_ORDER.map((s) => s.key)).size).toBe(
      SETTINGS_SECTION_ORDER.length
    );
  });

  it('is the design-reference order: Company, Team, Credits & billing, Notifications', () => {
    expect(SETTINGS_SECTION_ORDER.map((s) => s.key)).toEqual([
      'company',
      'team',
      'billing',
      'notifications',
    ]);
    expect(SETTINGS_SECTION_ORDER.map((s) => s.label)).toEqual([
      'Company',
      'Team',
      'Credits & billing',
      'Notifications',
    ]);
  });

  it('every row has an href matching /settings/<key> (team keeps its existing route)', () => {
    for (const section of SETTINGS_SECTION_ORDER) {
      expect(section.href).toBe(`/settings/${section.key}`);
    }
  });

  it('exactly one row requires MANAGE_MEMBERS, and it is team', () => {
    const gated = SETTINGS_SECTION_ORDER.filter((s) => s.requiresManageMembers);
    expect(gated).toHaveLength(1);
    expect(gated[0]?.key).toBe('team');
  });
});

describe('resolveActiveSection', () => {
  it.each([
    ['/settings/company', 'company'],
    ['/settings/team', 'team'],
    ['/settings/billing', 'billing'],
    ['/settings/notifications', 'notifications'],
  ] as const)('%s → %s', (pathname, expected) => {
    expect(resolveActiveSection(pathname)).toBe(expected);
  });

  it.each([
    ['/settings', null],
    ['/settings/account', null],
    // ⚠ The function documents `/settings/<section>` — assert it ENFORCES that root, so a future
    // caller can't get 'billing' out of a path that has nothing to do with client Settings.
    ['/expert/settings/billing', null],
    ['/anything/billing', null],
    ['/settings/team/deep', 'team'], // deep child paths still resolve segment 2
    ['/', null],
    ['', null],
    ['/settings/__proto__', null],
    ['/settings/constructor', null],
    ['/settings/toString', null],
    ['/settings/valueOf', null],
  ] as const)('%s → %s', (pathname, expected) => {
    expect(resolveActiveSection(pathname)).toBe(expected);
  });
});
