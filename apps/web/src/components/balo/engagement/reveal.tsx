'use client';

import { motion, useReducedMotion } from 'motion/react';

interface RevealProps {
  children: React.ReactNode;
  /** Stagger delay in seconds (matches the prototype's slideUp cascade). */
  delay?: number;
}

/**
 * Entrance-animation wrapper for the delivery workspace. Wraps
 * already-server-rendered children in a `motion/react` element that fades and
 * slides up on mount. Only the rendered React nodes cross the client boundary
 * here — never the `EngagementWorkspaceView` object — so the `@balo/db`
 * client-bundle footgun cannot fire. Reduced-motion is explicitly honored via
 * `useReducedMotion`: when the user prefers reduced motion the children render in
 * a plain wrapper immediately at rest, with no entrance transform.
 */
export function Reveal({ children, delay = 0 }: Readonly<RevealProps>): React.JSX.Element {
  const shouldReduceMotion = useReducedMotion();
  if (shouldReduceMotion) {
    return <div>{children}</div>;
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
    >
      {children}
    </motion.div>
  );
}
