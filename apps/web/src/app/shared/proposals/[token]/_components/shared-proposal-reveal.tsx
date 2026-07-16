'use client';

import { motion, useReducedMotion } from 'motion/react';

interface SharedProposalRevealProps {
  children: React.ReactNode;
  /** Stagger position — each section reveals `index * 80ms` after the first. */
  index?: number;
  className?: string;
}

/**
 * Subtle staggered entrance for the public shared-proposal sections (BAL-386), matching
 * the approved prototype and the balo-ui motion standard. A thin `'use client'` wrapper
 * so the surrounding server components stay server-rendered. Respects
 * `prefers-reduced-motion`: when reduced, it renders with no initial offset and no
 * animation (the content is painted in its final position).
 */
export function SharedProposalReveal({
  children,
  index = 0,
  className,
}: Readonly<SharedProposalRevealProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={reduce ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: reduce ? 0 : index * 0.08 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
