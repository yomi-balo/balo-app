import { describe, expect, it } from 'vitest';
import { dailyParticipantIdFor } from '@balo/shared/meetings';
import { presentGuestIdsFrom } from './present-guest-ids';

/**
 * BAL-436 — ⚠⚠ THE FAIL-CLOSED CLAIM IS THE WHOLE TEST. It must be impossible for this to
 * report somebody as present who is not, because the panel uses the answer to decide whether a
 * host is shown a "Re-send link" affordance against a specific `meeting_guests` row.
 */

const GUEST_UUID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const MEMBER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('presentGuestIdsFrom', () => {
  it('decodes a `g`-tagged claim back to its canonical guest uuid', () => {
    const claim = dailyParticipantIdFor('guest', GUEST_UUID);

    expect([...presentGuestIdsFrom([claim])]).toEqual([GUEST_UUID]);
  });

  it('⚠ EXCLUDES a `u`-tagged claim — a MEMBER is not a guest', () => {
    // Both ids are uuids, which is the entire reason the encoding tags them apart. Treating a
    // member's id as a guest id would mark an unrelated roster row as present.
    const claim = dailyParticipantIdFor('user', MEMBER_UUID);

    expect(presentGuestIdsFrom([claim]).size).toBe(0);
  });

  it('keeps the guests and drops the members out of a mixed room', () => {
    const ids = [
      dailyParticipantIdFor('user', MEMBER_UUID),
      dailyParticipantIdFor('guest', GUEST_UUID),
    ];

    expect([...presentGuestIdsFrom(ids)]).toEqual([GUEST_UUID]);
  });

  it.each([
    ['a bare hyphenated uuid', GUEST_UUID],
    ['a bare 32-char hex run', GUEST_UUID.replaceAll('-', '')],
    ['UPPERCASE hex behind a valid tag', `g${GUEST_UUID.replaceAll('-', '').toUpperCase()}`],
    ['an unknown tag', `x${GUEST_UUID.replaceAll('-', '')}`],
    ['a vendor-generated participant id', 'daily-participant-9f3c'],
    ['an empty string', ''],
    ['a truncated claim', `g${GUEST_UUID.replaceAll('-', '').slice(0, 20)}`],
  ])('⚠ yields NOTHING for %s — never a guess', (_label, value) => {
    expect(presentGuestIdsFrom([value]).size).toBe(0);
  });

  it('returns an empty set for an empty room', () => {
    expect(presentGuestIdsFrom([]).size).toBe(0);
  });

  it('de-duplicates a guest who appears twice (a rejoin mid-poll)', () => {
    const claim = dailyParticipantIdFor('guest', GUEST_UUID);

    expect(presentGuestIdsFrom([claim, claim]).size).toBe(1);
  });
});
