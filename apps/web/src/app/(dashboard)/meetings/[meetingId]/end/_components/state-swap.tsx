'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

/**
 * BAL-389 — the IN-CARD state swap, as ONE definition.
 *
 * Two places on this screen replace their own content in place after a consequential answer:
 * the rating block (ask → "Thanks — saved.") and the resolve prompt (ask → "Case closed." /
 * the "Not yet" acknowledgement). Both are exactly the "meaningful state change" and "success
 * confirmation" moments balo-ui puts at the top of the motion budget, and both were snapping.
 *
 * ⚠ ONE COMPONENT, TWO CONSUMERS, DELIBERATELY. Two hand-written `AnimatePresence` blocks with
 * the same four transition props is the near-identical-block shape SonarCloud's >3% new-code
 * duplication gate catches (memory `reference_sonar_duplication_not_caught_locally`), and it is
 * also two places for the timing to drift from the approved table.
 *
 * ⚠ `mode="wait"` SO THE OUTGOING ANSWER LEAVES BEFORE THE NEW ONE ARRIVES. On a card this
 * small a crossfade overlaps two blocks of centred text and reads as a glitch.
 *
 * ⚠⚠ FOCUS IS MOVED BY **CALLBACK REFS** IN THE CONSUMERS, NEVER BY A TIMER. Under
 * `mode="wait"` the incoming child is not mounted in the same commit as the state change, so a
 * `requestAnimationFrame` or `useEffect` that reaches for the new node finds nothing and focus
 * falls to `<body>` — the exact defect `@/test/motion-stub`'s docblock was written about. A
 * callback ref fires when the node actually mounts, whenever that is.
 *
 * ⚠ REDUCED MOTION GETS THE SAME LAYOUT, just no transform — the same contract `Reveal` keeps.
 * 200ms / `easeOut` is the approved "state change" row of the balo-ui motion table.
 */
export function StateSwap({
  swapKey,
  className,
  children,
}: Readonly<{
  /** Changing this is what triggers the swap. One stable string per branch. */
  swapKey: string;
  className?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  const shouldReduceMotion = useReducedMotion();
  if (shouldReduceMotion) {
    return <div className={className}>{children}</div>;
  }
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={swapKey}
        className={className}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
