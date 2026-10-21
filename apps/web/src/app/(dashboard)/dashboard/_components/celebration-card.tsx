'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { motion } from 'motion/react';
import { ExternalLink, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { markLiveCelebrationSeenAction } from '../_actions/mark-live-celebration-seen';

const CONFETTI_COLORS = [
  '#2563EB',
  '#7C3AED',
  '#059669',
  '#D97706',
  '#DB2777',
  '#0891B2',
  '#F59E0B',
];

const confettiAnimations = ['confetti1', 'confetti2', 'confetti3'] as const;

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { y: 16, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

interface CelebrationCardProps {
  /** `null` when the expert has no username yet — the card then omits its button. */
  publicProfileHref: string | null;
}

export function CelebrationCard({
  publicProfileHref,
}: Readonly<CelebrationCardProps>): React.JSX.Element {
  // Stamp "seen" once the card is on screen — never during render, which also runs on a Link
  // prefetch. The action is conditional server-side, so a StrictMode double-call stamps once.
  useEffect(() => {
    markLiveCelebrationSeenAction().catch((error: unknown) => {
      Sentry.captureException(error);
    });
  }, []);

  return (
    <motion.section
      aria-label="You're live on the marketplace"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="border-border bg-card relative mb-5 overflow-hidden rounded-xl border px-8 py-12 text-center"
    >
      {/* Confetti particles */}
      {CONFETTI_COLORS.map((color, i) => (
        <div
          key={color}
          className="pointer-events-none absolute"
          style={{
            left: `${15 + i * 10}%`,
            top: '35%',
            width: 8,
            height: 8,
            borderRadius: i % 2 === 0 ? '50%' : 2,
            backgroundColor: color,
            animation: `${confettiAnimations[i % 3]} ${1.5 + i * 0.15}s ease-out ${i * 0.1}s forwards`,
          }}
        />
      ))}

      {/* Green gradient circle with Zap icon */}
      <motion.div variants={itemVariants} className="flex justify-center">
        <div
          className="mb-5 flex h-[76px] w-[76px] items-center justify-center rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500"
          style={{ boxShadow: '0 8px 32px rgba(5,150,105,0.3)' }}
        >
          <Zap className="h-8 w-8 text-white" />
        </div>
      </motion.div>

      {/* Heading */}
      <motion.h3 variants={itemVariants} className="text-foreground text-xl font-semibold">
        You&apos;re live on the marketplace!
      </motion.h3>

      {/* Description */}
      <motion.p variants={itemVariants} className="text-muted-foreground mt-2 text-sm">
        Clients can now find and book you. Time to land your first consultation.
      </motion.p>

      {/* CTA */}
      {publicProfileHref !== null && (
        <motion.div variants={itemVariants} className="mt-6">
          <Button
            asChild
            className="text-white"
            style={{ background: 'linear-gradient(135deg, #059669, #0891B2)' }}
          >
            <a href={publicProfileHref} target="_blank" rel="noopener noreferrer">
              View your public profile
              <ExternalLink size={14} aria-hidden="true" />
              <span className="sr-only"> (opens in new tab)</span>
            </a>
          </Button>
        </motion.div>
      )}

      <motion.p variants={itemVariants} className="text-subtle-foreground mt-3.5 text-xs">
        From now on, your status sits next to your name.
      </motion.p>
    </motion.section>
  );
}
