'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ReactionFloater } from './use-meeting-realtime';

/**
 * BAL-437 — the floating reaction layer over the video stage.
 *
 * ⚠⚠ `pointer-events-none` AND `aria-hidden`, BOTH LOAD-BEARING.
 *
 *   · **Pointer events:** this layer covers the whole stage. Without the class it would eat
 *     every click on the video — the spotlight swap, the overflow tile, the stage's own
 *     controls — for the 2.2 seconds a reaction is in flight, on a live call.
 *   · **`aria-hidden`:** a floater is a transient decoration with no persistent meaning. A
 *     screen reader announcing "thumbs up" six times while somebody is speaking is a denial of
 *     service, and §16 reserves the ONE polite live region for mutation outcomes. If reactions
 *     ever need to be perceivable non-visually, that is a summary line somewhere, not this.
 *
 * ⚠ `prefers-reduced-motion` FADES IN PLACE INSTEAD OF RISING. Not "a shorter rise" — a rise is
 * exactly the vestibular trigger the preference exists to suppress, and the emoji is still
 * fully visible for its whole life either way.
 *
 * ⚠ THE REACT KEY IS THE **NONCE**, never an array index (SonarCloud S6479). Two identical
 * emoji floating at once is the normal case — double taps are expected — so an index key would
 * make React reuse the wrong node and the animations would jump.
 *
 * ⚠ NO IDENTITY IS RENDERED, and none is available: the wire payload carries `{ emoji, nonce }`
 * and nothing else. The design's floaters are unattributed by intent.
 */

export interface ReactionFloatersProps {
  readonly floaters: readonly ReactionFloater[];
}

export function ReactionFloaters({ floaters }: Readonly<ReactionFloatersProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion() === true;

  return (
    <div
      data-testid="reaction-floaters"
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex items-end justify-center gap-2"
    >
      <AnimatePresence initial={false}>
        {floaters.map((floater) => (
          <motion.span
            key={floater.nonce}
            className="text-3xl select-none"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 0, scale: 0.8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: [0, 1, 1, 0], y: -140, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.15 : 2.2, ease: 'easeOut' }}
          >
            {floater.emoji}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
