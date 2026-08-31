/**
 * BAL-498 — shared pixel geometry for the Week grid AND the availability shading overlay. PURE,
 * client-safe. Both `week-grid.tsx` and `availability-shading.tsx` import these so the two
 * layers stay pixel-aligned without prop-drilling a computed layout object between them.
 */

/** 64px per hour — a 15-minute meeting (16px) still shows one line; a 30-minute one (32px)
 *  comfortably fits time + title on two lines. */
export const PX_PER_MINUTE = 64 / 60;

export const GUTTER_WIDTH_PX = 56;

/** Overlap sub-columns never shrink below this — 3+ concurrent meetings scroll the day column
 *  horizontally instead of compressing text past legibility. */
export const MIN_OVERLAP_COLUMN_WIDTH_PX = 72;

const DEFAULT_GRID_START_MINUTES = 7 * 60; // 07:00
const DEFAULT_GRID_END_MINUTES = 19 * 60; // 19:00
const GRID_PADDING_MINUTES = 60;
const MINUTES_PER_DAY = 1440;

export interface MinuteSpan {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

/**
 * The grid's vertical range. Default 7 AM–7 PM; extended by 1h of padding to cover any meeting
 * that starts earlier or ends later, never clipping content out of view.
 *
 * ⚠ THE EXTREMES ARE FOUND FIRST, THE PADDING APPLIED ONCE (BAL-498 fix round 3, R10). The
 * previous implementation folded padding into a running `start` as it walked the list, so the
 * result depended on INPUT ORDER: `[{360},{300}]` compared 300 against the ALREADY-PADDED 300
 * (from the 06:00 span) and left `start` at 300 — the 05:00 meeting then sat flush at `top: 0`
 * with no padding — while `[{300},{360}]` correctly produced 240. Never clipped content, so the
 * symptom was cosmetic; the contract was still wrong, and every existing case here used a single
 * span, which cannot see it.
 */
export function computeGridRangeMinutes(spans: readonly MinuteSpan[]): {
  start: number;
  end: number;
} {
  let earliest = DEFAULT_GRID_START_MINUTES;
  let latest = DEFAULT_GRID_END_MINUTES;
  for (const span of spans) {
    if (span.startMinutes < earliest) earliest = span.startMinutes;
    if (span.endMinutes > latest) latest = span.endMinutes;
  }
  return {
    start:
      earliest < DEFAULT_GRID_START_MINUTES
        ? Math.max(0, earliest - GRID_PADDING_MINUTES)
        : DEFAULT_GRID_START_MINUTES,
    end:
      latest > DEFAULT_GRID_END_MINUTES
        ? Math.min(MINUTES_PER_DAY, latest + GRID_PADDING_MINUTES)
        : DEFAULT_GRID_END_MINUTES,
  };
}

export interface OverlapAssignment {
  readonly column: number;
  readonly columnCount: number;
}

/**
 * Greedy interval-column assignment for same-day overlapping meetings (the familiar
 * Google/Outlook side-by-side pattern). `columnCount` is the day's PEAK concurrency, applied to
 * every item in that day — a deliberate simplification over a per-cluster count, which keeps the
 * algorithm linear-simple and never visually competes with the meeting content.
 */
export function assignOverlapColumns(items: readonly MinuteSpan[]): OverlapAssignment[] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) => a.item.startMinutes - b.item.startMinutes || a.item.endMinutes - b.item.endMinutes
    );

  const columnEnds: number[] = [];
  const columnByIndex = new Map<number, number>();

  for (const { item, index } of order) {
    let placed = -1;
    for (let column = 0; column < columnEnds.length; column += 1) {
      const end = columnEnds[column];
      if (end !== undefined && end <= item.startMinutes) {
        placed = column;
        break;
      }
    }
    if (placed === -1) {
      placed = columnEnds.length;
      columnEnds.push(item.endMinutes);
    } else {
      columnEnds[placed] = item.endMinutes;
    }
    columnByIndex.set(index, placed);
  }

  const columnCount = Math.max(1, columnEnds.length);
  return items.map((_, index) => ({ column: columnByIndex.get(index) ?? 0, columnCount }));
}
