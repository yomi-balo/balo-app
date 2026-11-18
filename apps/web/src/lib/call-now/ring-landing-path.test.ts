import { describe, expect, it } from 'vitest';
import type { CallRingStatus } from '@balo/shared/meetings';
import { ringLandingPath, type RingLandingFacts } from './ring-landing-path';

const NOW = new Date('2026-11-17T10:00:00.000Z');
const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';

function ring(
  status: CallRingStatus,
  expiresAt: string,
  overrides: Partial<RingLandingFacts> = {}
): RingLandingFacts {
  return {
    status,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    expiresAt,
    awaitsAnswer: false,
    meetingEnded: false,
    ...overrides,
  };
}

const CALL_ROOM = `/meetings/${MEETING_ID}/call`;
const CASE = `/cases/${ENGAGEMENT_ID}`;

describe('ringLandingPath', () => {
  it('opens the call room for a live ring', () => {
    expect(ringLandingPath(ring('ringing', '2026-11-17T10:01:00.000Z'), NOW)).toBe(CALL_ROOM);
  });

  it('opens the call room for a connected ring even past its expiry', () => {
    expect(ringLandingPath(ring('connected', '2026-11-17T09:00:00.000Z'), NOW)).toBe(CALL_ROOM);
  });

  it('opens the case for a ringing row whose window has passed', () => {
    expect(ringLandingPath(ring('ringing', '2026-11-17T09:59:59.000Z'), NOW)).toBe(CASE);
  });

  it('opens the case at the exact expiry instant', () => {
    expect(ringLandingPath(ring('ringing', NOW.toISOString()), NOW)).toBe(CASE);
  });

  it.each<CallRingStatus>(['unanswered', 'declined', 'stopped'])(
    'opens the case for a %s ring',
    (status) => {
      expect(ringLandingPath(ring(status, '2026-11-17T10:01:00.000Z'), NOW)).toBe(CASE);
    }
  );

  it('opens the call room for an expert callee on a live client-started ring', () => {
    expect(ringLandingPath(ring('ringing', '2026-11-17T10:01:00.000Z'), NOW)).toBe(CALL_ROOM);
  });

  it('opens the case, not the call room, for a client callee who must answer first', () => {
    expect(
      ringLandingPath(ring('ringing', '2026-11-17T10:01:00.000Z', { awaitsAnswer: true }), NOW)
    ).toBe(CASE);
  });

  it('opens the call room for a client callee on an in-place ring', () => {
    expect(
      ringLandingPath(ring('ringing', '2026-11-17T10:01:00.000Z', { awaitsAnswer: false }), NOW)
    ).toBe(CALL_ROOM);
  });

  it('opens the case for a connected ring whose meeting has ended', () => {
    expect(
      ringLandingPath(ring('connected', '2026-11-17T09:00:00.000Z', { meetingEnded: true }), NOW)
    ).toBe(CASE);
  });
});
