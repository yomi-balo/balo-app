import { describe, expect, it } from 'vitest';
import { AUTO_ACCEPT_DAYS, REVIEW_REMINDER_LEAD_DAYS, autoAcceptAt } from './delivery-review';

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
