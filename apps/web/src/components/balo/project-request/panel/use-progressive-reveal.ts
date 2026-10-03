'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReducedMotion } from 'motion/react';

/**
 * BAL-589 — BAL-254's AI brief delivers a finished draft, never a stream; this hook is
 * what makes a case-mount's finished brief FEEL drafted. It reveals `html`'s top-level blocks
 * one at a time, client-side, over an already-complete string — there is no new streaming
 * transport ("No real streaming" is explicit).
 *
 * Splitting on `DOMParser`, never a regex (SonarCloud S5852 — a hand-rolled tag scan over
 * arbitrary HTML is a ReDoS surface; `DOMParser` is linear and exact).
 */

const REVEAL_INTERVAL_MS = 120;

export interface ProgressiveRevealResult {
  /** True while blocks are still being added — false once every block is visible (or instantly,
   *  under reduced motion). */
  revealing: boolean;
  /** The HTML revealed so far — every block when `revealing` is false. `''` while `html` is
   *  `null`. */
  visibleHtml: string;
}

/**
 * Split `html` into its top-level block elements. A document with no element children (e.g. a
 * bare text run) reveals as a single block — the whole string — rather than character-by-
 * character, which would make the interval cost unbounded on long plain text.
 */
function splitTopLevelBlocks(html: string): string[] {
  if (html.length === 0) return [];
  if (typeof DOMParser === 'undefined') return [html];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.body.children).map((node) => node.outerHTML);
  return blocks.length > 0 ? blocks : [html];
}

/**
 * Progressively reveal `html`'s blocks, one every {@link REVEAL_INTERVAL_MS}. `runKey` forces a
 * fresh reveal even when `html` is unchanged in STRING VALUE but is a new generation run (not
 * applicable today since every redraft produces different text, but keeps the contract honest
 * for a future identical-output edge case). `null` (no brief yet / flow idle) reveals nothing.
 *
 * `prefers-reduced-motion` reveals every block immediately — `revealing` goes straight to
 * `false` and `visibleHtml` is the full string on the very first render for that `html`.
 */
export function useProgressiveReveal(html: string | null, runKey: number): ProgressiveRevealResult {
  const reduce = useReducedMotion();
  const blocks = useMemo(() => (html === null ? [] : splitTopLevelBlocks(html)), [html]);
  const [visibleCount, setVisibleCount] = useState(0);
  // ⚠⚠ Reset `visibleCount` DURING RENDER when `runKey` changes, not from inside
  // the effect below. A redraft lands a new `runKey` (usually with FEWER blocks) in the same
  // render that recomputes `blocks`; resetting only from the effect left `visibleCount` from the
  // PREVIOUS run on screen for one paint — e.g. a 3-block reveal collapsing to 1 block briefly
  // read as "fully revealed" before the effect caught up. This is React's own documented pattern
  // for resetting state when a prop changes, so it needs no extra effect.
  const [seenRunKey, setSeenRunKey] = useState(runKey);
  if (seenRunKey !== runKey) {
    setSeenRunKey(runKey);
    setVisibleCount(0);
  }

  useEffect(() => {
    if (blocks.length === 0) {
      setVisibleCount(0);
      return;
    }
    if (reduce) {
      setVisibleCount(blocks.length);
      return;
    }
    setVisibleCount(0);
    let revealed = 0;
    const id = setInterval(() => {
      revealed += 1;
      setVisibleCount(revealed);
      if (revealed >= blocks.length) clearInterval(id);
    }, REVEAL_INTERVAL_MS);
    return () => clearInterval(id);
    // `runKey` is intentionally in the dependency list though unused in the body — it is the
    // caller's signal that THIS is a new run, even if `blocks` happens to be referentially or
    // structurally identical to the last one.
  }, [blocks, runKey, reduce]);

  const revealing = visibleCount < blocks.length;
  const visibleHtml = blocks.slice(0, visibleCount).join('');
  return { revealing, visibleHtml };
}
