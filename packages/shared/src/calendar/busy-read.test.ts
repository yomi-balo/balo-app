import { describe, it, expect } from 'vitest';
import {
  BUSY_READABLE_CREDENTIAL_STATUS,
  isConsideredForBusyRead,
  isUnreadable,
  unreadableBusyReadTargets,
} from './busy-read';

describe('busy-read predicates', () => {
  it('readable status is ACTIVE', () => {
    expect(BUSY_READABLE_CREDENTIAL_STATUS).toBe('ACTIVE');
  });

  it.each([
    ['provisioned with conflict-checked calendars', true, ['c1'], true],
    ['provisioned with calendarIds [] (opted out)', true, [], false],
    ['unprovisioned with no calendars', false, [], true],
    ['unprovisioned with calendars', false, ['c1'], true],
  ])('isConsideredForBusyRead: %s', (_label, provisioned, calendarIds, expected) => {
    expect(isConsideredForBusyRead({ provisioned, calendarIds })).toBe(expected);
  });

  it.each([
    ['ACTIVE', true, false],
    ['ACTIVE', false, true],
    ['EXPIRED', true, true],
    ['SYNC_PENDING', true, true],
    ['SYNC_PENDING', false, true],
  ])('isUnreadable: %s provisioned=%s', (credentialStatus, provisioned, expected) => {
    expect(isUnreadable({ credentialStatus, provisioned })).toBe(expected);
  });

  it('provisioned with calendarIds [] + EXPIRED is not considered, so never unreadable', () => {
    const target = { credentialStatus: 'EXPIRED', provisioned: true, calendarIds: [] };
    expect(isConsideredForBusyRead(target)).toBe(false);
    expect(unreadableBusyReadTargets([target])).toEqual([]);
  });

  it('unprovisioned + SYNC_PENDING is unreadable', () => {
    const target = { credentialStatus: 'SYNC_PENDING', provisioned: false, calendarIds: [] };
    expect(unreadableBusyReadTargets([target])).toEqual([target]);
  });

  it('returns only the considered, unreadable target from a mixed list', () => {
    const ok = { credentialStatus: 'ACTIVE', provisioned: true, calendarIds: ['a'] };
    const expired = { credentialStatus: 'EXPIRED', provisioned: true, calendarIds: ['b'] };
    expect(unreadableBusyReadTargets([ok, expired])).toEqual([expired]);
  });
});
