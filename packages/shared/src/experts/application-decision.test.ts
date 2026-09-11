import { describe, it, expect } from 'vitest';
import {
  EXPERT_DECLINE_REASONS,
  applicationWaitingDays,
  narrowToExpertDeclineReason,
  type ExpertDeclineReason,
} from './application-decision';

/**
 * BAL-549 — the decline vocabulary and the ONE days-waiting derivation.
 *
 * ⚠ EVERY FIXTURE IS RELATIVE TO A FROZEN `NOW`, NEVER `Date.now()` AND NEVER A BARE CALENDAR
 * LITERAL COMPARED AGAINST THE REAL CLOCK. A hardcoded date fixture goes red on a calendar day
 * with no code change; `applicationWaitingDays` takes its clock as a parameter precisely so
 * this suite can pin one.
 */
const NOW = new Date('2026-01-15T00:00:00.000Z');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** `n` whole days (plus an optional hour offset) before the frozen `NOW`. */
function ago(days: number, hours = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS - hours * HOUR_MS);
}

describe('EXPERT_DECLINE_REASONS', () => {
  it('holds exactly the four labels, in order', () => {
    expect([...EXPERT_DECLINE_REASONS]).toEqual([
      'experience_depth',
      'credentials_unverified',
      'application_incomplete',
      'not_a_fit',
    ]);
  });
});

describe('narrowToExpertDeclineReason', () => {
  it.each([...EXPERT_DECLINE_REASONS])('returns %s for its own label', (reason) => {
    expect(narrowToExpertDeclineReason(reason)).toBe(reason);
  });

  it.each([
    ['a non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { reason: 'not_a_fit' }],
    ['an empty string', ''],
    ['an unknown label', 'too_expensive'],
    ['a prefix of a real label', 'experience'],
    ['a superstring of a real label', 'not_a_fit_at_all'],
  ])('returns null for %s', (_label, value) => {
    expect(narrowToExpertDeclineReason(value)).toBeNull();
  });

  it('narrows to the union without a cast', () => {
    const narrowed: ExpertDeclineReason | null = narrowToExpertDeclineReason('not_a_fit');
    expect(narrowed).toBe('not_a_fit');
  });
});

describe('applicationWaitingDays', () => {
  it('floors to whole days — 6d 23h is 6, not 7', () => {
    expect(applicationWaitingDays(ago(6, 23), NOW)).toBe(6);
  });

  it('floors a 7d 1h wait to 7', () => {
    expect(applicationWaitingDays(ago(7, 1), NOW)).toBe(7);
  });

  it('returns 0 for a null submittedAt', () => {
    expect(applicationWaitingDays(null, NOW)).toBe(0);
  });

  it('returns 0, never a negative, for a submittedAt in the future', () => {
    const future = new Date(NOW.getTime() + DAY_MS);
    expect(applicationWaitingDays(future, NOW)).toBe(0);
  });

  it('returns 0 for a submission at exactly now', () => {
    expect(applicationWaitingDays(NOW, NOW)).toBe(0);
  });
});
