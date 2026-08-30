import { describe, it, expect } from 'vitest';
import { NAV_BADGE_NEEDS_ATTENTION, hasMoreAttention, moreButtonLabel } from './nav-badges';
import type { EnabledNavEntry } from './nav-registry';

describe('NAV_BADGE_NEEDS_ATTENTION.expertChecklist (BAL-501)', () => {
  it('needs attention when the checklist is incomplete', () => {
    expect(
      NAV_BADGE_NEEDS_ATTENTION.expertChecklist({
        checklistCompletedCount: 3,
        checklistAllComplete: false,
      })
    ).toBe(true);
  });

  it('does NOT need attention once the checklist is all-complete', () => {
    expect(
      NAV_BADGE_NEEDS_ATTENTION.expertChecklist({
        checklistCompletedCount: 5,
        checklistAllComplete: true,
      })
    ).toBe(false);
  });
});

function badgedEntry(): EnabledNavEntry {
  return {
    key: 'expert_settings',
    label: 'Expert Settings',
    icon: (() => null) as unknown as EnabledNavEntry['icon'],
    section: 'secondary',
    workspaceTypes: ['expert'],
    requires: () => true,
    mobilePriority: 'more',
    badgeSource: 'expertChecklist',
    enabled: true,
    href: '/expert/settings',
  };
}

function unbadgedEntry(): EnabledNavEntry {
  return {
    key: 'account',
    label: 'Account',
    icon: (() => null) as unknown as EnabledNavEntry['icon'],
    section: 'secondary',
    workspaceTypes: ['company', 'expert'],
    requires: () => true,
    mobilePriority: 'more',
    enabled: true,
    href: '/settings/account',
  };
}

describe('hasMoreAttention (BAL-501)', () => {
  it('false when no item carries a badge', () => {
    expect(
      hasMoreAttention([unbadgedEntry()], {
        checklistCompletedCount: 0,
        checklistAllComplete: false,
      })
    ).toBe(false);
  });

  it('false when the badged item is complete', () => {
    expect(
      hasMoreAttention([badgedEntry()], { checklistCompletedCount: 5, checklistAllComplete: true })
    ).toBe(false);
  });

  it('true when the badged item is incomplete', () => {
    expect(
      hasMoreAttention([badgedEntry()], { checklistCompletedCount: 3, checklistAllComplete: false })
    ).toBe(true);
  });
});

describe('moreButtonLabel (BAL-501)', () => {
  it('0 → plain "More"', () => {
    expect(moreButtonLabel(0)).toBe('More');
  });

  it('1 → singular grammar', () => {
    expect(moreButtonLabel(1)).toBe('More, 1 item needs attention');
  });

  it('2 → plural grammar', () => {
    expect(moreButtonLabel(2)).toBe('More, 2 items need attention');
  });
});
