import { describe, it, expect } from 'vitest';
import type { CalendarConnection } from '@balo/db';
import { isWritableConnection, pickBookingWriteTarget } from './booking-write-target.js';

function makeConnection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn-1',
    expertProfileId: 'expert-1',
    provider: 'google',
    endUserAccountId: 'eua-1',
    credentialStatus: 'ACTIVE',
    providerEmail: 'dana@example.com',
    credentialCheckedAt: null,
    reconnectNotifiedAt: null,
    targetCalendarId: 'cal-1',
    lastSyncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('isWritableConnection', () => {
  it('is true for an ACTIVE connection with a target calendar', () => {
    expect(
      isWritableConnection(
        makeConnection({ credentialStatus: 'ACTIVE', targetCalendarId: 'cal-1' })
      )
    ).toBe(true);
  });

  it('is false for a REVOKED connection even with a target calendar', () => {
    expect(
      isWritableConnection(
        makeConnection({ credentialStatus: 'REVOKED', targetCalendarId: 'cal-1' })
      )
    ).toBe(false);
  });

  it('is false for an ACTIVE connection with no target calendar', () => {
    expect(
      isWritableConnection(makeConnection({ credentialStatus: 'ACTIVE', targetCalendarId: null }))
    ).toBe(false);
  });
});

describe('pickBookingWriteTarget', () => {
  it('picks the first (oldest) of two ACTIVE rows with targets', () => {
    const oldest = makeConnection({ id: 'conn-oldest' });
    const newer = makeConnection({ id: 'conn-newer', targetCalendarId: 'cal-2' });
    expect(pickBookingWriteTarget([oldest, newer])?.id).toBe('conn-oldest');
  });

  it('picks the newer connection when the older one is EXPIRED', () => {
    const older = makeConnection({ id: 'conn-older', credentialStatus: 'EXPIRED' });
    const newer = makeConnection({ id: 'conn-newer', targetCalendarId: 'cal-2' });
    expect(pickBookingWriteTarget([older, newer])?.id).toBe('conn-newer');
  });

  it('picks the newer connection when the older one has no target calendar', () => {
    const older = makeConnection({ id: 'conn-older', targetCalendarId: null });
    const newer = makeConnection({ id: 'conn-newer', targetCalendarId: 'cal-2' });
    expect(pickBookingWriteTarget([older, newer])?.id).toBe('conn-newer');
  });

  it('skips a SYNC_PENDING connection', () => {
    const pending = makeConnection({ id: 'conn-pending', credentialStatus: 'SYNC_PENDING' });
    const active = makeConnection({ id: 'conn-active', targetCalendarId: 'cal-2' });
    expect(pickBookingWriteTarget([pending, active])?.id).toBe('conn-active');
  });

  it('returns undefined when nothing is writable', () => {
    const expired = makeConnection({ credentialStatus: 'EXPIRED' });
    const noTarget = makeConnection({ id: 'conn-2', targetCalendarId: null });
    expect(pickBookingWriteTarget([expired, noTarget])).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(pickBookingWriteTarget([])).toBeUndefined();
  });
});
