import { describe, expect, it } from 'vitest';
import { BOOKABLE_CONTEXT_TYPES } from './bookable-contexts';

/**
 * BAL-129 — the pin for the list `apps/api`'s Zod enum, its tenancy gate and
 * `@balo/analytics`'s `MeetingBookingContextType` all read. Widening it silently admits a
 * label at every one of those layers at once, including the projection module that has no
 * rule for `request_interaction` and the two labels the ticket scoped out.
 */
describe('BOOKABLE_CONTEXT_TYPES', () => {
  it('is exactly the four bookable labels, in order', () => {
    expect(BOOKABLE_CONTEXT_TYPES).toEqual([
      'case',
      'project_kickoff',
      'package_session',
      'project_discovery',
    ]);
  });

  it('excludes `admin`, `retainer_checkin` and `request_interaction`', () => {
    // Each for its own reason — see the module docblock. `request_interaction` is BAL-283's:
    // the consultation projection throws `MeetingContextNotProjectableError` for it, so
    // admitting it here would turn a booking into a 500-shaped rollback.
    const excluded = ['admin', 'retainer_checkin', 'request_interaction'];
    for (const label of excluded) {
      expect(BOOKABLE_CONTEXT_TYPES).not.toContain(label);
    }
  });

  it('holds no duplicates — the tuple is the source of a union type', () => {
    expect(new Set(BOOKABLE_CONTEXT_TYPES).size).toBe(BOOKABLE_CONTEXT_TYPES.length);
  });
});
