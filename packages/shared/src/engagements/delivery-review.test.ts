import { describe, expect, it } from 'vitest';
import {
  AUTO_ACCEPT_DAYS,
  REVIEW_REMINDER_LEAD_DAYS,
  autoAcceptAt,
  deliveryReviewWait,
} from './delivery-review';

describe('delivery-review constants', () => {
  it('pins the review window and the reminder lead', () => {
    expect(AUTO_ACCEPT_DAYS).toBe(7);
    expect(REVIEW_REMINDER_LEAD_DAYS).toBe(2);
  });
});

describe('autoAcceptAt', () => {
  it('is the request instant plus the auto-accept window', () => {
    const requestedAt = new Date('2026-07-03T10:30:00.000Z');
    expect(autoAcceptAt(requestedAt)).toEqual(new Date('2026-07-10T10:30:00.000Z'));
  });

  it('does not mutate its input', () => {
    const requestedAt = new Date('2026-07-03T10:30:00.000Z');
    autoAcceptAt(requestedAt);
    expect(requestedAt.toISOString()).toBe('2026-07-03T10:30:00.000Z');
  });
});

describe('deliveryReviewWait', () => {
  const requestedAt = new Date('2026-11-18T01:00:00.000Z');

  it('waits on a pending_acceptance project with a completion request', () => {
    expect(
      deliveryReviewWait({ status: 'pending_acceptance', completionRequestedAt: requestedAt })
    ).toEqual({
      anchor: requestedAt,
      autoAcceptAt: new Date('2026-11-25T01:00:00.000Z'),
    });
  });

  it('does not wait without a completion request', () => {
    expect(
      deliveryReviewWait({ status: 'pending_acceptance', completionRequestedAt: null })
    ).toBeNull();
  });

  it.each(['in_progress', 'accepted', 'completed', 'draft'])('does not wait while %s', (status) => {
    expect(deliveryReviewWait({ status, completionRequestedAt: requestedAt })).toBeNull();
  });
});
