import { describe, it, expect } from 'vitest';
import { CAPABILITIES } from '@balo/shared/authz';
import { resolveNavItems, type NavContext } from './nav-registry';

describe('resolveNavItems secondary section (BAL-347 Team nav gating → BAL-495 registry → BAL-503)', () => {
  it('client → Settings + Account, regardless of MANAGE_MEMBERS', () => {
    const context: NavContext = { workspaceType: 'company', capabilities: [] };
    expect(resolveNavItems(context, 'secondary').map((i) => i.href)).toEqual([
      '/settings',
      '/settings/account',
    ]);
  });

  it('client, can manage company → Settings + Account (identical to the no-manage case — the client bottom section no longer varies by capability)', () => {
    const context: NavContext = {
      workspaceType: 'company',
      capabilities: [CAPABILITIES.MANAGE_MEMBERS],
    };
    expect(resolveNavItems(context, 'secondary').map((i) => i.href)).toEqual([
      '/settings',
      '/settings/account',
    ]);
  });

  it('expert, cannot manage company → Expert Settings + Account', () => {
    const context: NavContext = { workspaceType: 'expert', capabilities: [] };
    expect(resolveNavItems(context, 'secondary').map((i) => i.href)).toEqual([
      '/expert/settings',
      '/settings/account',
    ]);
  });

  it('expert, can manage company → Expert Settings + Team + Account', () => {
    const context: NavContext = {
      workspaceType: 'expert',
      capabilities: [CAPABILITIES.MANAGE_MEMBERS],
    };
    expect(resolveNavItems(context, 'secondary').map((i) => i.href)).toEqual([
      '/expert/settings',
      '/settings/team',
      '/settings/account',
    ]);
  });

  it('labels the Team item and points it at /settings/team (expert workspace)', () => {
    const context: NavContext = {
      workspaceType: 'expert',
      capabilities: [CAPABILITIES.MANAGE_MEMBERS],
    };
    const team = resolveNavItems(context, 'secondary').find((i) => i.href === '/settings/team');
    expect(team?.label).toBe('Team');
  });

  it('labels the Settings item and points it at /settings (company workspace)', () => {
    const context: NavContext = { workspaceType: 'company', capabilities: [] };
    const settings = resolveNavItems(context, 'secondary').find((i) => i.href === '/settings');
    expect(settings?.label).toBe('Settings');
  });
});
