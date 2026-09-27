import { describe, expect, it } from 'vitest';
import { joinNotOpenYetMessage } from './lobby';

/**
 * D16 (owner-approved copy) — "This call isn't open yet — you can join from {time}." `{time}` is `opensAt` in the
 * VIEWER's timezone, through the existing meeting-time formatter, date-qualified when it is not the viewer's
 * local today (D17.4). The suite runs under `TZ=UTC`, so the expected strings below are the full literals. `now`
 * is always pinned explicitly — see `joinNotOpenYetMessage`'s own docblock on why.
 */
describe('joinNotOpenYetMessage (D16, D17.3, D17.4)', () => {
  const TODAY = new Date('2026-09-25T00:00:00.000Z');

  it('⚠⚠ is the approved sentence, pinned against the FULL literal, with the time ALONE on the viewer’s today', () => {
    expect(joinNotOpenYetMessage('2026-09-25T11:57:00.000Z', TODAY)).toBe(
      "This call isn't open yet — you can join from 11:57 AM."
    );
    expect(joinNotOpenYetMessage('2026-09-25T15:03:00.000Z', TODAY)).toBe(
      "This call isn't open yet — you can join from 3:03 PM."
    );
  });

  it('⚠⚠ D17.4 — date-qualifies the time when `opensAt` is NOT the viewer’s local today', () => {
    // `now` is still 2026-09-25; the opening instant is the next calendar day.
    expect(joinNotOpenYetMessage('2026-09-26T11:57:00.000Z', TODAY)).toBe(
      "This call isn't open yet — you can join from Sat, Sep 26 at 11:57 AM."
    );
  });

  it('uses the ASCII apostrophe and the em dash exactly as approved, on both the today and not-today shapes', () => {
    for (const [opensAt, now] of [
      ['2026-09-25T11:57:00.000Z', TODAY],
      ['2026-09-26T11:57:00.000Z', TODAY],
    ] as const) {
      const message = joinNotOpenYetMessage(opensAt, now);
      expect(message).not.toBeNull();
      expect(message?.startsWith("This call isn't open yet — you can join from ")).toBe(true);
      expect(message?.endsWith('.')).toBe(true);
    }
  });

  it.each([null, undefined, '', 'not a date'])(
    'D17.3 — an unusable `opensAt` (%s) is `null`, never a placeholder time or a new string',
    (opensAt) => {
      expect(joinNotOpenYetMessage(opensAt, TODAY)).toBeNull();
    }
  );

  it('names no party, no gendered pronoun and no countdown', () => {
    const message = joinNotOpenYetMessage('2026-09-25T11:57:00.000Z', TODAY);
    expect(message).not.toBeNull();
    const words = message?.toLowerCase().split(/[^a-z]+/) ?? [];
    for (const banned of ['he', 'she', 'him', 'her', 'his', 'hers']) {
      expect(words).not.toContain(banned);
    }
  });
});
