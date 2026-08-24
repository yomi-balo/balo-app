import type { BusyBlock } from './types.js';

/**
 * BAL-409 (D7, arm 2) — subtract ONE window from a list of busy blocks, splitting a block that
 * strictly contains it into two.
 *
 * ⚠⚠ THE RESIDUAL, WRITTEN INTO THE HELPER ITSELF SO IT IS NOT READ AS SOLVED: subtraction
 * clips EVERY vendor interval over `[window.startAt, window.endAt)`, so an unrelated expert
 * event living entirely inside the OLD window is ignored for the portion of the NEW window that
 * overlaps the old one. This is the accepted residual from the orchestrator's A1 answer — SHIP
 * THE ARCHITECT'S DESIGN (both arms) — because refusing every small nudge for any expert with a
 * connected calendar (arm 1 only) would fail the feature's single most common case, and doing so
 * with a silent 409.
 *
 * PARTIAL OVERLAPS STILL BLOCK — that is the property that makes subtraction (not deletion)
 * safe, and it is the one a later refactor would break. A block that only PARTIALLY overlaps
 * `window` is clipped to what remains outside `window`, never dropped outright.
 *
 * PURE. Order-independent over the input list; the output order follows the input order with
 * a split block's two halves adjacent.
 */
export function subtractInterval(blocks: readonly BusyBlock[], window: BusyBlock): BusyBlock[] {
  const windowStart = window.startAt.getTime();
  const windowEnd = window.endAt.getTime();
  const result: BusyBlock[] = [];

  for (const block of blocks) {
    const blockStart = block.startAt.getTime();
    const blockEnd = block.endAt.getTime();

    // No overlap at all — unchanged.
    if (blockEnd <= windowStart || blockStart >= windowEnd) {
      result.push(block);
      continue;
    }

    // Full containment — the window swallows the whole block. Drop it.
    if (windowStart <= blockStart && blockEnd <= windowEnd) {
      continue;
    }

    // Partial overlap at the head of the block (window covers the block's start).
    if (windowStart <= blockStart && windowEnd < blockEnd) {
      result.push({ startAt: window.endAt, endAt: block.endAt });
      continue;
    }

    // Partial overlap at the tail of the block (window covers the block's end).
    if (blockStart < windowStart && blockEnd <= windowEnd) {
      result.push({ startAt: block.startAt, endAt: window.startAt });
      continue;
    }

    // The window sits strictly INSIDE the block — split it into two.
    result.push({ startAt: block.startAt, endAt: window.startAt });
    result.push({ startAt: window.endAt, endAt: block.endAt });
  }

  return result;
}
