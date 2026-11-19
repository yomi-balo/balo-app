import { describe, it, expect } from 'vitest';
import { toSettleableSession, type SettleableSession } from './settlement';

describe('toSettleableSession', () => {
  const settleable: SettleableSession = {
    id: 'session-1',
    companyId: 'company-1',
    walletId: 'wallet-1',
    expertProfileId: 'expert-1',
    overdraftSettledMinor: 1250,
    openedBy: 'client',
    meetingId: 'meeting-1',
  };

  it('keeps exactly the settleable fields of a full session row, dropping the rest', () => {
    const row = { ...settleable, engagementId: 'engagement-1', ratePerMinuteMinor: 300 };

    expect(toSettleableSession(row)).toEqual(settleable);
  });

  it('carries the meeting id, and a session with no meeting as null (BAL-651)', () => {
    expect(toSettleableSession(settleable).meetingId).toBe('meeting-1');
    expect(toSettleableSession({ ...settleable, meetingId: null }).meetingId).toBeNull();
  });
});
