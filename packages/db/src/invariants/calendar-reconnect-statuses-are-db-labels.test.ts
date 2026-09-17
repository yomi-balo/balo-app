import { describe, it, expect } from 'vitest';
import { RECONNECT_NEEDED_CREDENTIAL_STATUSES } from '@balo/shared/experts';
import { CALENDAR_CREDENTIAL_STATUSES } from '../schema/calendar';

/**
 * BAL-566 R2 — CROSS-PACKAGE VOCABULARY PIN for the calendar-disconnected banner.
 *
 * `@balo/shared/experts`' `RECONNECT_NEEDED_CREDENTIAL_STATUSES` is a `ReadonlySet<string>`,
 * because `@balo/shared` cannot import `@balo/db`'s `CalendarCredentialStatus` union (the
 * dependency direction is `@balo/db → @balo/shared`, never the reverse). Nothing therefore
 * typechecks its members against the column's real vocabulary: a DB-side rename of `EXPIRED`
 * would leave the set matching ZERO rows forever, and the banner would silently never fire for
 * an expert whose calendar has broken — while they drop out of expert search.
 *
 * This file is the check the compiler cannot make. It lives in `packages/db`, beside the
 * vocabulary's single home (`schema/calendar.ts`), so the failure lands where the rename is made.
 *
 * ⚠ IF THIS FAILS, DO NOT JUST EDIT THE SET. Decide what the renamed/added label means for the
 * banner: a new "broken" label belongs in the set; a new provisioning label does not.
 */

const DB_LABELS: readonly string[] = CALENDAR_CREDENTIAL_STATUSES;

describe('invariant: RECONNECT_NEEDED_CREDENTIAL_STATUSES are real calendar_connections labels (BAL-566 R2)', () => {
  it('both sides resolve and are non-empty (guards a vacuous pass)', () => {
    expect(DB_LABELS.length).toBeGreaterThan(0);
    expect(RECONNECT_NEEDED_CREDENTIAL_STATUSES.size).toBe(2);
  });

  it('every reconnect status is a member of CALENDAR_CREDENTIAL_STATUSES', () => {
    const members = [...RECONNECT_NEEDED_CREDENTIAL_STATUSES];
    expect(members).toHaveLength(RECONNECT_NEEDED_CREDENTIAL_STATUSES.size);
    expect(members.filter((status) => !DB_LABELS.includes(status))).toEqual([]);
  });

  it('ACTIVE is a DB label and is NOT a reconnect status (the healthy state)', () => {
    expect(DB_LABELS).toContain('ACTIVE');
    expect(RECONNECT_NEEDED_CREDENTIAL_STATUSES.has('ACTIVE')).toBe(false);
  });

  it('SYNC_PENDING is a DB label and is NOT a reconnect status (provisioning, not breakage)', () => {
    expect(DB_LABELS).toContain('SYNC_PENDING');
    expect(RECONNECT_NEEDED_CREDENTIAL_STATUSES.has('SYNC_PENDING')).toBe(false);
  });

  it('every DB label is classified: exactly ACTIVE and SYNC_PENDING fall outside the set', () => {
    // Pins the COMPLEMENT too, so a fifth DB label added later surfaces here and gets a
    // deliberate answer rather than defaulting to "not broken".
    expect(DB_LABELS.filter((status) => !RECONNECT_NEEDED_CREDENTIAL_STATUSES.has(status))).toEqual(
      ['ACTIVE', 'SYNC_PENDING']
    );
  });
});
