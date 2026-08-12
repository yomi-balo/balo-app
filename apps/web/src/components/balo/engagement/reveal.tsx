'use client';

import { motion, useReducedMotion } from 'motion/react';

interface RevealProps {
  children: React.ReactNode;
  /** Stagger delay in seconds (matches the prototype's slideUp cascade). */
  delay?: number;
  /**
   * Classes for the wrapper element itself.
   *
   * ⚠ ADDED BY BAL-388, AND ADDITIVE — every existing call site omits it and is unchanged.
   * On the recap the Reveal IS the grid child, so the mobile DOM-order rule
   * (`order-last lg:order-none` on the transcript) has nowhere else to land. Precedent:
   * `SharedProposalReveal` already accepts one. Applied to BOTH branches, so a
   * reduced-motion viewer gets the same LAYOUT — only the entrance transform is dropped.
   */
  className?: string;
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
export function Reveal({
  children,
  delay = 0,
  className,
}: Readonly<RevealProps>): React.JSX.Element {
  const shouldReduceMotion = useReducedMotion();
  if (shouldReduceMotion) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
    >
      {children}
    </motion.div>
  );
}
