import { describe, expect, it } from 'vitest';
import { bookingSlotSchema } from './booking-slot-schema';

describe('bookingSlotSchema', () => {
  it('accepts a slot whose window matches durationMinutes exactly', () => {
    const result = bookingSlotSchema.safeParse({
      startIso: '2026-09-01T04:00:00.000Z',
      endIso: '2026-09-01T04:30:00.000Z',
      durationMinutes: 30,
    });
    expect(result.success).toBe(true);
  });

  it.each([15, 30, 45, 60])('accepts every rung of the duration ladder (%i minutes)', (minutes) => {
    const start = new Date('2026-09-01T04:00:00.000Z');
    const end = new Date(start.getTime() + minutes * 60_000);
    const result = bookingSlotSchema.safeParse({
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      durationMinutes: minutes,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a duration off the ladder, even when the window agrees with it', () => {
    const result = bookingSlotSchema.safeParse({
      startIso: '2026-09-01T04:00:00.000Z',
      endIso: '2026-09-01T04:20:00.000Z',
      durationMinutes: 20,
    });
    expect(result.success).toBe(false);
  });

  /**
   * B1 (BAL-478, extracted here in fix round 3) — the spoof this schema exists to close: a
   * ladder-valid `durationMinutes` declared against a window of a DIFFERENT size. Named
   * `invalid_request` at the boundary, never reaching a caller's gate.
   */
  it('rejects a ladder-valid durationMinutes that disagrees with the window (the spoof)', () => {
    const result = bookingSlotSchema.safeParse({
      startIso: '2026-09-01T04:00:00.000Z',
      endIso: '2026-09-01T07:00:00.000Z', // 3 hours
      durationMinutes: 15, // cheapest rung
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected rejection');
    expect(result.error.issues[0]?.path).toEqual(['endIso']);
  });

  it('rejects an unparseable instant as a named validation error, never NaN arithmetic', () => {
    const result = bookingSlotSchema.safeParse({
      startIso: 'not-a-real-instant',
      endIso: '2026-09-01T04:30:00.000Z',
      durationMinutes: 30,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field (.strict())', () => {
    const result = bookingSlotSchema.safeParse({
      startIso: '2026-09-01T04:00:00.000Z',
      endIso: '2026-09-01T04:30:00.000Z',
      durationMinutes: 30,
      timezone: 'UTC',
    });
    expect(result.success).toBe(false);
  });
});
