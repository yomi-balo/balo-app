import { describe, expect, it } from 'vitest';
import { BOOKABLE_CONTEXT_TYPES } from './bookable-contexts';

/**
 * BAL-129 / BAL-283 — the pin for the list `apps/api`'s Zod enum, its tenancy gate and
 * `@balo/analytics`'s `MeetingBookingContextType` all read. Widening it silently admits a
 * label at every one of those layers at once.
 */
describe('BOOKABLE_CONTEXT_TYPES', () => {
  it('is exactly the five bookable labels, in order', () => {
    expect(BOOKABLE_CONTEXT_TYPES).toEqual([
      'case',
      'project_kickoff',
      'package_session',
      'project_discovery',
      'request_interaction',
    ]);
  });

  it('excludes `admin` and `retainer_checkin`', () => {
    // Each for its own reason — see the module docblock. `request_interaction` was moved OFF
    // this excluded set by BAL-283 (Ruling 1): the consultation projection now has a rule for
    // it, so admitting it here no longer turns a booking into a 500-shaped rollback.
    const excluded = ['admin', 'retainer_checkin'];
    for (const label of excluded) {
      expect(BOOKABLE_CONTEXT_TYPES).not.toContain(label);
    }
  });

  it('holds no duplicates — the tuple is the source of a union type', () => {
    expect(new Set(BOOKABLE_CONTEXT_TYPES).size).toBe(BOOKABLE_CONTEXT_TYPES.length);
  });
});
