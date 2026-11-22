'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Opens and closes a block's own room: height and opacity together, in and out, so content that
 * streams in after the page (the Call now entry, the client's Online badge) never shoves what sits
 * below it in one jump, and leaves the same way.
 *
 * ⚠ `overflow-hidden` IS WHAT MAKES THE HEIGHT ANIMATE, AND IT CLIPS. A focusable child needs room
 * for its focus ring: pass `-mx-1 -mb-1 px-1 pb-1` (or similar) so the ring sits inside the box
 * without moving the child.
 *
 * ⚠ REDUCED MOTION KEEPS THE SAME ELEMENT TREE, only an instant transition — `useReducedMotion()`
 * is null on the server, so branching the tree on it would hydrate to a different element.
 * 200 ms / `easeOut` is the balo-ui "state change" row.
 */
export function HeightReveal({
  show,
  className,
  children,
}: Readonly<{
  show: boolean;
  className?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="reveal"
          className={cn('overflow-hidden', className)}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
