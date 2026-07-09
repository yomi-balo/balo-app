import { describe, it, expect } from 'vitest';
import { getBottomNavItems } from './sidebar';

describe('getBottomNavItems (BAL-347 Team nav gating)', () => {
  it('client, cannot manage company → Account only', () => {
    expect(getBottomNavItems('client', false).map((i) => i.href)).toEqual(['/settings/account']);
  });

  it('client, can manage company → Team + Account', () => {
    expect(getBottomNavItems('client', true).map((i) => i.href)).toEqual([
      '/settings/team',
      '/settings/account',
    ]);
  });

  it('expert, cannot manage company → Expert Settings + Account', () => {
    expect(getBottomNavItems('expert', false).map((i) => i.href)).toEqual([
      '/expert/settings',
      '/settings/account',
    ]);
  });

  it('expert, can manage company → Expert Settings + Team + Account', () => {
    expect(getBottomNavItems('expert', true).map((i) => i.href)).toEqual([
      '/expert/settings',
      '/settings/team',
      '/settings/account',
    ]);
  });

  it('labels the Team item and points it at /settings/team', () => {
    const team = getBottomNavItems('client', true).find((i) => i.href === '/settings/team');
    expect(team?.label).toBe('Team');
  });
});
