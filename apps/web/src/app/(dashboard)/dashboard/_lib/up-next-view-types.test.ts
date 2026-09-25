import { describe, it, expect } from 'vitest';
import { UP_NEXT_ROW_VIEW_KEYS, ASSERT_UP_NEXT_KEYS_COMPLETE } from './up-next-view-types';

describe('UP_NEXT_ROW_VIEW_KEYS (BAL-566, key-set pin)', () => {
  it('is exactly the twelve UpNextRowView field names', () => {
    expect([...UP_NEXT_ROW_VIEW_KEYS].sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'meetingId',
        'contextType',
        'title',
        'counterpartyName',
        'counterpartyOrgLabel',
        'scheduledStart',
        'scheduledEnd',
        'status',
        'href',
        'joinPath',
        'rescheduleProposalExpiresAt',
        'roomReady',
      ].sort((a, b) => a.localeCompare(b))
    );
    expect(UP_NEXT_ROW_VIEW_KEYS).toHaveLength(12);
  });

  it('contains no money, rate, fee, email or room/token-shaped key — except the one readiness boolean', () => {
    // BAL-581 — `roomReady` matches `/room/i`, but it is a readiness BOOLEAN, not a room locator.
    // Exempt it BY NAME (never weaken the regex): the pattern still rejects roomName, roomUrl,
    // dailyRoomName and joinUrl.
    const READINESS_BOOLEAN_KEYS: readonly string[] = ['roomReady'];
    for (const key of UP_NEXT_ROW_VIEW_KEYS.filter((k) => !READINESS_BOOLEAN_KEYS.includes(k))) {
      expect(key).not.toMatch(
        /cents|rate|fee|price|amount|balance|email|joinurl|room|token|workos|phone/i
      );
    }
  });

  it('BAL-581 — exactly one room-shaped key exists, so a second one fails here', () => {
    expect(UP_NEXT_ROW_VIEW_KEYS.filter((k) => /room/i.test(k))).toEqual(['roomReady']);
  });

  it('F15: the compile-time key-completeness assertion is exported, referenced, and true', () => {
    // The real enforcement is the `satisfies` check at its declaration site (a missing key fails
    // `tsc`, not this test) — this just proves the constant is not dead code.
    expect(ASSERT_UP_NEXT_KEYS_COMPLETE).toBe(true);
  });
});
