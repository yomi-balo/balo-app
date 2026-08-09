import { describe, expect, it } from 'vitest';
import { dailyRoomNameForMeeting } from './room-name';

/**
 * BAL-129 — THE PIN. `provision-meeting.ts`'s entire idempotency argument (no `ON CONFLICT`,
 * no room stranded BY THE CONCURRENT RACE, no conditional write) holds only while this name
 * stays a pure, injective function of `meetings.id`. Every assertion below exists to make a
 * random / salted / suffixed name a RED TEST rather than a quiet behaviour change.
 *
 * ⚠ THE MIDDLE CLAUSE IS DELIBERATELY NARROW AND USED TO BE WRONG HERE. It is NOT "no orphan
 * room": three live paths strand a room at the vendor, and `room-name.ts` (3) plus
 * `provision-meeting.ts` both name them and their owners. What the injective name buys is that
 * a room created for meeting M can only ever be claimed by M — so the RACE strands nothing, and
 * every stranded room stays addressable by re-deriving its name. That is what makes the
 * follow-ups cheap; it is not what makes them unnecessary. The last fix round corrected the
 * source and left this pinning test asserting the retracted version.
 */

const MEETING_A = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const MEETING_B = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5e';
const MEETING_C = 'ffffffff-0000-4000-8000-123456789abc';

describe('dailyRoomNameForMeeting', () => {
  it('produces the pinned `balo-` + 32-hex format', () => {
    expect(dailyRoomNameForMeeting(MEETING_A)).toMatch(/^balo-[0-9a-f]{32}$/);
  });

  it('is exactly 37 characters — inside Daily’s 41-character room-name limit', () => {
    expect(dailyRoomNameForMeeting(MEETING_A)).toHaveLength(37);
  });

  it('uses only Daily’s permitted `[A-Za-z0-9_-]` alphabet', () => {
    expect(dailyRoomNameForMeeting(MEETING_A)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([MEETING_A, MEETING_B, MEETING_C])(
    'is a PURE function of the id — %s matches an independently derived reference',
    (meetingId) => {
      /**
       * ⚠ THIS REPLACES A TAUTOLOGY. `expect(f(A)).toBe(f(A))` passes against `() => 'x'` and
       * against any impure implementation whose salt happens to be stable within one process
       * — i.e. against exactly the changes this file exists to block. Comparing against a
       * reference derivation computed here instead means a random, salted, suffixed,
       * time-dependent or counter-based name is a RED TEST, which is what
       * `provision-meeting.ts`'s no-`ON CONFLICT` / no-conditional-write argument needs.
       */
      expect(dailyRoomNameForMeeting(meetingId)).toBe(
        `balo-${meetingId.replaceAll('-', '').toLowerCase()}`
      );
    }
  );

  it('is injective — two meetings differing by one hex digit get different names', () => {
    // AC #2 is mechanical because of exactly this: two bookings on the same engagement are
    // two uuids, so they are two rooms, and `meeting_daily_room_name_idx` can never fire.
    expect(dailyRoomNameForMeeting(MEETING_A)).not.toBe(dailyRoomNameForMeeting(MEETING_B));
  });

  it('normalises an uppercase uuid to lowercase', () => {
    // Postgres hands back lowercase, but a hand-written caller (or a test fixture) may not —
    // and a case-differing name would resolve to a DIFFERENT Daily room for the same meeting.
    expect(dailyRoomNameForMeeting(MEETING_A.toUpperCase())).toBe(
      dailyRoomNameForMeeting(MEETING_A)
    );
  });

  it('strips every hyphen — the derived name embeds the uuid’s 32 hex digits verbatim', () => {
    expect(dailyRoomNameForMeeting(MEETING_A)).toBe('balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d');
  });
});
