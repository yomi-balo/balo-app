import { describe, expect, it } from 'vitest';
import type { StaffAccessSaveRefusal } from '@balo/shared/authz';
import {
  STAFF_ACCESS_SAVE_MESSAGES,
  STAFF_CANDIDATE_MESSAGES,
  staffAccessFailureNeedsReload,
  type StaffAccessFailureCode,
} from './staff-access-outcome';

const ALL_REFUSALS: readonly StaffAccessSaveRefusal[] = [
  'unknown_capability',
  'custom_list_requires_staff_role',
  'staff_management_requires_super_admin',
  'self_edit',
  'actor_not_authorized',
  'target_not_found',
  'stale',
  'no_change',
  'target_ineligible',
  'grant_exceeds_actor',
  'floor_violation',
];

describe('STAFF_ACCESS_SAVE_MESSAGES', () => {
  it('has a message for every failure code except actor_not_authorized, plus denied/invalid/failed', () => {
    const codes = Object.keys(STAFF_ACCESS_SAVE_MESSAGES);
    expect(codes.sort()).toEqual(
      [
        ...ALL_REFUSALS.filter((r) => r !== 'actor_not_authorized'),
        'denied',
        'invalid',
        'failed',
      ].sort()
    );
  });

  it('every message is non-empty', () => {
    for (const message of Object.values(STAFF_ACCESS_SAVE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('does not include a code for actor_not_authorized directly — the gate maps it to denied', () => {
    expect(Object.hasOwn(STAFF_ACCESS_SAVE_MESSAGES, 'actor_not_authorized')).toBe(false);
  });
});

describe('STAFF_CANDIDATE_MESSAGES', () => {
  it('has exactly the four candidate codes', () => {
    expect(Object.keys(STAFF_CANDIDATE_MESSAGES).sort()).toEqual(
      ['denied', 'invalid', 'not_found', 'failed'].sort()
    );
  });

  it('shares the same denied string as the save messages', () => {
    expect(STAFF_CANDIDATE_MESSAGES.denied).toBe(STAFF_ACCESS_SAVE_MESSAGES.denied);
  });
});

describe('staffAccessFailureNeedsReload', () => {
  it('is true for stale, target_not_found, floor_violation, unknown_capability, target_ineligible', () => {
    const reload: readonly StaffAccessFailureCode[] = [
      'stale',
      'target_not_found',
      'floor_violation',
      'unknown_capability',
      'target_ineligible',
    ];
    for (const code of reload) {
      expect(staffAccessFailureNeedsReload(code), code).toBe(true);
    }
  });

  it('is false for every other code', () => {
    const noReload: readonly StaffAccessFailureCode[] = [
      'self_edit',
      'custom_list_requires_staff_role',
      'staff_management_requires_super_admin',
      'no_change',
      'grant_exceeds_actor',
      'denied',
      'invalid',
      'failed',
    ];
    for (const code of noReload) {
      expect(staffAccessFailureNeedsReload(code), code).toBe(false);
    }
  });
});
