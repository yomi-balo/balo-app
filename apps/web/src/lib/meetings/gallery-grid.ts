/**
 * BAL-435 — the gallery's column count, as a LOOKUP TABLE rather than a formula.
 *
 * The derivation is recorded so the numbers can be re-derived:
 *
 *   cols = clamp(ceil(sqrt(N × stageAspect ÷ tileAspect)), 1, maxCols)
 *   with stageAspect ≈ 16/9, tileAspect = 16/10, maxCols = 2 / 3 / 4 by breakpoint.
 *
 * ⚠ IT SHIPS AS A TABLE because a table is TESTABLE AT EVERY N and N only goes to 10 (the soft
 * `MAX_MEETING_PARTICIPANTS` cap). CLAUDE.md's data-driven rule, applied.
 *
 * ⚠⚠ THE VALUES ARE TAILWIND CLASS STRINGS, SO **CSS** DOES THE RESPONSIVENESS. `useIsMobile`
 * renders `false` on the first paint (it has no `matchMedia` until an effect runs), so a
 * JS-driven column count would flash the wrong grid on every join.
 */

/** ⚠ Every string is a literal — never interpolated, or Tailwind cannot see the class. */
const GALLERY_GRID_BY_TILE_COUNT: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-2',
  4: 'grid-cols-2',
  5: 'grid-cols-2 lg:grid-cols-3',
  6: 'grid-cols-2 lg:grid-cols-3',
  7: 'grid-cols-2 sm:grid-cols-3',
  8: 'grid-cols-2 sm:grid-cols-3',
  9: 'grid-cols-2 sm:grid-cols-3',
  10: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
};

/** The most CELLS the grid ever renders. Above it, cell 10 becomes the overflow tile. */
export const MAX_GALLERY_CELLS = 10;

/**
 * ⚠ MOBILE SCROLLS FROM SEVEN. Two columns × 4–5 rows exceeds the stage, so the mobile gallery
 * scrolls with row snapping — and the active speaker is sorted into the first row, so scrolling
 * is always optional.
 */
export const GALLERY_MOBILE_SCROLL_FROM = 7;

/**
 * The grid class for a tile count.
 *
 * ⚠ CLAMPED AT BOTH ENDS. Zero (a momentary empty frame during a re-join) renders one column
 * rather than crashing on a missing key; above the cap we render 9 tiles + 1 overflow tile —
 * i.e. still 10 cells.
 */
export function galleryGridClass(tileCount: number): string {
  const clamped = Math.min(Math.max(Math.trunc(tileCount), 1), MAX_GALLERY_CELLS);
  // ⚠ `noUncheckedIndexedAccess` is on: narrow by destructure + guard, never with `!`.
  const found = GALLERY_GRID_BY_TILE_COUNT[clamped];
  return found ?? 'grid-cols-1';
}

/** Whether the mobile gallery needs its scroll + snap treatment at this tile count. */
export function galleryScrollsOnMobile(tileCount: number): boolean {
  return tileCount >= GALLERY_MOBILE_SCROLL_FROM;
}
