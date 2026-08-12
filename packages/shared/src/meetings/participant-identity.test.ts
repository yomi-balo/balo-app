import { describe, expect, it } from 'vitest';
import {
  DAILY_PARTICIPANT_ID_LENGTH,
  DAILY_PARTICIPANT_ID_MAX_LENGTH,
  dailyParticipantIdFor,
  parseDailyParticipantId,
} from './participant-identity';

/** A canonical lowercase v4 uuid. */
const USER_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('dailyParticipantIdFor', () => {
  it('encodes a member as `u` + the hyphen-stripped uuid', () => {
    expect(dailyParticipantIdFor('user', USER_ID)).toBe('u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d');
  });

  it('encodes a guest as `g` + the hyphen-stripped uuid', () => {
    expect(dailyParticipantIdFor('guest', GUEST_ID)).toBe('ga1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d');
  });

  it('lowercases an uppercase uuid — the encoding emits one canonical form', () => {
    expect(dailyParticipantIdFor('user', USER_ID.toUpperCase())).toBe(
      dailyParticipantIdFor('user', USER_ID)
    );
  });

  it('⚠ the two kinds of the SAME uuid differ in EXACTLY the first character', () => {
    // This is the whole encoding in one assertion: the kind tag is the only thing that
    // distinguishes a `users.id` claim from a `meeting_guests.id` claim, and both ids are
    // uuids drawn from the same space — the same uuid CAN legitimately name a user row and
    // a guest row.
    const asUser = dailyParticipantIdFor('user', USER_ID);
    const asGuest = dailyParticipantIdFor('guest', USER_ID);

    expect(asUser).not.toBe(asGuest);
    expect(asUser.slice(1)).toBe(asGuest.slice(1));
    expect(asUser.charAt(0)).toBe('u');
    expect(asGuest.charAt(0)).toBe('g');
  });
});

describe('the length bound (the reason the `u:`/`g:` prefix form was rejected)', () => {
  it.each([
    ['user', USER_ID],
    ['guest', GUEST_ID],
  ] as const)('a %s id is exactly DAILY_PARTICIPANT_ID_LENGTH characters', (kind, id) => {
    expect(dailyParticipantIdFor(kind, id)).toHaveLength(DAILY_PARTICIPANT_ID_LENGTH);
  });

  it('fits inside Daily`s documented `user_id` maximum', () => {
    // ⚠ 33 ≤ 36 — VERIFIED against Daily's `POST /v1/meeting-tokens` reference, not assumed.
    // A `u:` / `g:` prefix on the FULL 36-char uuid would be 38 and would NOT fit, which is
    // why this encoding strips hyphens rather than merely prefixing.
    expect(DAILY_PARTICIPANT_ID_LENGTH).toBeLessThanOrEqual(DAILY_PARTICIPANT_ID_MAX_LENGTH);
    expect(dailyParticipantIdFor('guest', GUEST_ID).length).toBeLessThanOrEqual(
      DAILY_PARTICIPANT_ID_MAX_LENGTH
    );
  });
});

describe('parseDailyParticipantId — round trip', () => {
  it.each([
    ['user', USER_ID],
    ['guest', GUEST_ID],
  ] as const)('round-trips a %s identity back to its kind and canonical uuid', (kind, id) => {
    expect(parseDailyParticipantId(dailyParticipantIdFor(kind, id))).toEqual({ kind, id });
  });

  it('returns the uuid canonically HYPHENATED and lowercase, ready for a `WHERE id = $1`', () => {
    const parsed = parseDailyParticipantId(dailyParticipantIdFor('user', USER_ID.toUpperCase()));

    expect(parsed?.id).toBe(USER_ID);
    // 8-4-4-4-12, and no uppercase anywhere.
    expect(parsed?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('⚠⚠ parseDailyParticipantId REJECTS anything it did not mint', () => {
  /**
   * ⚠ THE BARE UUID CASE IS THE ONE THIS MODULE EXISTS FOR. An untagged uuid is ambiguous
   * between `users.id` and `meeting_guests.id`, and `meeting_presence` holds those two
   * columns apart with a CHECK. Returning a guess would put a guest's presence on a member's
   * row — a diarization AND a billing-clock defect. `null` means "identity unknown", which
   * the presence schema explicitly permits beside a known `party`.
   */
  it('returns null for a BARE hyphenated uuid', () => {
    expect(parseDailyParticipantId(USER_ID)).toBeNull();
  });

  it('returns null for a bare hyphen-STRIPPED uuid (32 hex, no tag)', () => {
    expect(parseDailyParticipantId(USER_ID.replace(/-/g, ''))).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['an unknown tag with 32 valid hex', 'x0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d'],
    ['a tag with 31 hex (one short)', 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5'],
    ['a tag with 33 hex (one long)', 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5dd'],
    ['UPPERCASE hex', 'U0F7B1C2D3E4F4A5B8C9D0E1F2A3B4C5D'],
    ['a lowercase tag with uppercase hex', 'u0F7B1C2D3E4F4A5B8C9D0E1F2A3B4C5D'],
    ['non-hex characters', 'uzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['a hyphenated uuid WITH a tag', `u${USER_ID}`],
    ['leading whitespace', ' u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d'],
    ['trailing whitespace', 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d '],
    ['a trailing newline (the anchored-pattern trap)', 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d\n'],
  ])('returns null for %s', (_label, value) => {
    expect(parseDailyParticipantId(value)).toBeNull();
  });

  it('does not fold an uppercase claim into a lowercase one — we only emit lowercase', () => {
    // Accepting it would make "did WE mint this?" unanswerable, and the answer to that
    // question is the only reason to trust the kind tag at all.
    const minted = dailyParticipantIdFor('user', USER_ID);
    expect(parseDailyParticipantId(minted.toUpperCase())).toBeNull();
    expect(parseDailyParticipantId(minted)).not.toBeNull();
  });
});
