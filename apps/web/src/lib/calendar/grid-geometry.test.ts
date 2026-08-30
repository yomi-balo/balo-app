import { describe, it, expect } from 'vitest';
import { computeGridRangeMinutes, assignOverlapColumns } from './grid-geometry';

describe('computeGridRangeMinutes', () => {
  it('defaults to 7am-7pm when every span is inside the default window', () => {
    const range = computeGridRangeMinutes([{ startMinutes: 9 * 60, endMinutes: 10 * 60 }]);
    expect(range).toEqual({ start: 7 * 60, end: 19 * 60 });
  });

  it('extends earlier, with 1h padding, for a 6am meeting', () => {
    const range = computeGridRangeMinutes([{ startMinutes: 6 * 60, endMinutes: 6 * 60 + 30 }]);
    expect(range.start).toBe(5 * 60);
    expect(range.end).toBe(19 * 60);
  });

  it('extends later, with 1h padding, for an 8pm meeting', () => {
    const range = computeGridRangeMinutes([{ startMinutes: 20 * 60, endMinutes: 20 * 60 + 30 }]);
    expect(range.end).toBe(21 * 60 + 30);
  });

  it('clamps to the day bounds', () => {
    const range = computeGridRangeMinutes([{ startMinutes: 0, endMinutes: 1440 }]);
    expect(range.start).toBe(0);
    expect(range.end).toBe(1440);
  });

  // ── BAL-498 fix round 3, R10 — ORDER INDEPENDENCE ────────────────────────────────────────
  //
  // Every case above uses ONE span, which cannot see the defect: the old implementation folded
  // the 1-hour padding into a RUNNING `start` as it walked, so a later, earlier span was
  // compared against an already-padded value. `[{06:00},{05:00}]` therefore produced
  // `start = 300` — the 05:00 meeting flush at `top: 0` with no padding at all — while the same
  // two spans in the other order produced the documented 240.
  it('pads from the EARLIEST span regardless of input order (R10)', () => {
    const ascending = computeGridRangeMinutes([
      { startMinutes: 5 * 60, endMinutes: 5 * 60 + 30 },
      { startMinutes: 6 * 60, endMinutes: 6 * 60 + 30 },
    ]);
    const descending = computeGridRangeMinutes([
      { startMinutes: 6 * 60, endMinutes: 6 * 60 + 30 },
      { startMinutes: 5 * 60, endMinutes: 5 * 60 + 30 },
    ]);

    expect(ascending).toEqual(descending);
    // 05:00 minus the documented 1h padding.
    expect(descending.start).toBe(4 * 60);
  });

  it('pads from the LATEST span regardless of input order (R10)', () => {
    const ascending = computeGridRangeMinutes([
      { startMinutes: 19 * 60, endMinutes: 20 * 60 },
      { startMinutes: 20 * 60, endMinutes: 21 * 60 },
    ]);
    const descending = computeGridRangeMinutes([
      { startMinutes: 20 * 60, endMinutes: 21 * 60 },
      { startMinutes: 19 * 60, endMinutes: 20 * 60 },
    ]);

    expect(ascending).toEqual(descending);
    expect(descending.end).toBe(22 * 60);
  });
});

describe('assignOverlapColumns', () => {
  it('gives non-overlapping meetings the same single column', () => {
    const result = assignOverlapColumns([
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 11 * 60, endMinutes: 12 * 60 },
    ]);
    expect(result).toEqual([
      { column: 0, columnCount: 1 },
      { column: 0, columnCount: 1 },
    ]);
  });

  it('splits two overlapping meetings into two columns', () => {
    const result = assignOverlapColumns([
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 9 * 60 + 30, endMinutes: 10 * 60 + 30 },
    ]);
    expect(result[0]?.column).toBe(0);
    expect(result[1]?.column).toBe(1);
    expect(result[0]?.columnCount).toBe(2);
    expect(result[1]?.columnCount).toBe(2);
  });

  it('reuses a freed column once its occupant ends', () => {
    const result = assignOverlapColumns([
      { startMinutes: 9 * 60, endMinutes: 9 * 60 + 15 },
      { startMinutes: 9 * 60 + 20, endMinutes: 9 * 60 + 40 },
    ]);
    expect(result[0]?.column).toBe(0);
    expect(result[1]?.column).toBe(0);
    expect(result[0]?.columnCount).toBe(1);
  });

  it('handles 3+ concurrent overlaps', () => {
    const result = assignOverlapColumns([
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
    ]);
    const columns = new Set(result.map((r) => r.column));
    expect(columns.size).toBe(3);
    expect(result.every((r) => r.columnCount === 3)).toBe(true);
  });

  it('returns an empty array for no items', () => {
    expect(assignOverlapColumns([])).toEqual([]);
  });
});
