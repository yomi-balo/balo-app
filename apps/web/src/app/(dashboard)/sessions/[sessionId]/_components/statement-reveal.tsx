'use client';

import { motion } from 'motion/react';

/**
 * One reveal, no internal stagger — the statement body arrives as one document, because that's
 * what it is (design "Motion Choreography"). Children are passed through the `children` slot so
 * the statement body itself stays an RSC and the lens-resolved payload never has to enter a
 * client component. Reduced motion → Motion's default instant opacity swap (no `y` transform).
 */
export function StatementReveal({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
