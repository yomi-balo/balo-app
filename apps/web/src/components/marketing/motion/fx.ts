/**
 * BAL-493 §11 — the marketing-home parallax transform presets, ported from the design
 * reference's `fxBench`/`fxFloat` (`marketing-home.jsx:1260-1276`). Each preset is a
 * {@link ParallaxCompute} — a pure `(scrollY, parentRect, viewportHeight) => transform-string`
 * function — consumed by `<Parallax compute={...}>` (`parallax.tsx`). Kept separate from
 * `parallax.tsx` so the presets stay pure and independently testable/reusable, matching the
 * plan's file split (`fx.ts` "Replaces (ref): fxBench/fxFloat").
 */

/**
 * Computes a CSS `transform` string for one animation frame.
 *
 * @param scrollY - `globalThis.scrollY` at the time of the frame.
 * @param parentRect - the bounding rect of the wrapped element's PARENT (not the element
 *   itself — see `parallax.tsx`'s docblock for why the element's own transform must not
 *   feed back into this computation).
 * @param viewportHeight - `globalThis.innerHeight`.
 */
export type ParallaxCompute = (
  scrollY: number,
  parentRect: DOMRect,
  viewportHeight: number
) => string;

/** Bench rows stop sliding after this much scroll (px) — matches the ref exactly. */
const BENCH_MAX_SCROLL_PX = 900;
/** Horizontal slide factor applied to the clamped scroll distance. */
const BENCH_HORIZONTAL_FACTOR = 0.22;
/** A small upward drift applied alongside the horizontal slide. */
const BENCH_VERTICAL_FACTOR = -0.06;

/**
 * Bench rows: slide sideways with the first ~900px of scroll, drift up a touch.
 * `direction` flips which way a given row slides (the two bench rows in the ref move
 * opposite ways, `FX_BENCH_A`/`FX_BENCH_B` below).
 */
export function fxBenchRow(direction: 1 | -1): ParallaxCompute {
  return (scrollY) => {
    const clamped = Math.min(scrollY, BENCH_MAX_SCROLL_PX);
    const x = (clamped * BENCH_HORIZONTAL_FACTOR * direction).toFixed(1);
    const y = (clamped * BENCH_VERTICAL_FACTOR).toFixed(1);
    return `translate3d(${x}px, ${y}px, 0)`;
  };
}

/**
 * Float against scroll, relative to the element's (parent's) distance from viewport centre.
 * `factor` scales how strongly the element floats — small positive/negative values used for
 * the receipt card and the two band glows below.
 */
export function fxFloat(factor: number): ParallaxCompute {
  return (_scrollY, parentRect, viewportHeight) => {
    const centre = parentRect.top + parentRect.height / 2 - viewportHeight / 2;
    return `translate3d(0, ${(centre * factor).toFixed(1)}px, 0)`;
  };
}

/** The five presets the ref hardcodes at `marketing-home.jsx:1269-1273`, used by name below. */
export const FX_BENCH_A: ParallaxCompute = fxBenchRow(-1);
export const FX_BENCH_B: ParallaxCompute = fxBenchRow(1);
export const FX_RECEIPT: ParallaxCompute = fxFloat(0.08);
export const FX_GLOW_A: ParallaxCompute = fxFloat(0.12);
export const FX_GLOW_B: ParallaxCompute = fxFloat(-0.08);
