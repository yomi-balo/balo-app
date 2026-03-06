'use client';

import { Clock, Mail, Rocket, ChevronRight, Check } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { scaleInVariant } from '../../_components/design-system';

interface SuccessContentProps {
  email: string;
}

const NEXT_STEPS = [
  {
    icon: Clock,
    label: 'We Review',
    description: 'Our team evaluates your profile and expertise',
  },
  {
    icon: Mail,
    label: "We'll Email You",
    description: "You'll hear from us when a decision is made",
  },
  {
    icon: Rocket,
    label: 'Start Consulting',
    description: 'Once approved, set your rates and start helping clients',
  },
] as const;

export function SuccessContent({ email }: Readonly<SuccessContentProps>): React.JSX.Element {
  return (
    <div className="relative flex flex-col items-center justify-center px-4 py-16">
      {/* Confetti keyframes */}
      <style>{`
        @keyframes confetti1 { 0% { transform: translateY(0) rotate(0deg); opacity: 1; } 100% { transform: translateY(-80px) rotate(180deg); opacity: 0; } }
        @keyframes confetti2 { 0% { transform: translateY(0) rotate(0deg); opacity: 1; } 100% { transform: translateY(-60px) rotate(-120deg) translateX(30px); opacity: 0; } }
        @keyframes confetti3 { 0% { transform: translateY(0) rotate(0deg); opacity: 1; } 100% { transform: translateY(-70px) rotate(90deg) translateX(-25px); opacity: 0; } }
      `}</style>

      {/* Background glow */}
      <div
        className="bg-primary/15 dark:bg-primary/25 absolute top-1/4 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full blur-3xl"
        aria-hidden="true"
      />

      {/* Gradient hero badge with confetti */}
      <div className="relative">
        <motion.div
          initial={scaleInVariant.initial}
          animate={scaleInVariant.animate}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="from-primary mx-auto flex h-[88px] w-[88px] items-center justify-center rounded-full bg-gradient-to-br to-violet-600 shadow-[0_8px_32px_rgba(37,99,235,0.3)]"
        >
          <Check className="h-10 w-10 text-white" strokeWidth={2.5} aria-hidden="true" />
        </motion.div>

        {/* Confetti particles */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div
            className="bg-primary absolute top-1/2 left-1/2 h-2 w-2 rounded-sm"
            style={{ animation: 'confetti1 1s ease-out 0.4s forwards' }}
          />
          <div
            className="absolute top-1/2 left-1/2 h-2 w-2 rounded-sm bg-violet-500"
            style={{ animation: 'confetti2 1.1s ease-out 0.5s forwards' }}
          />
          <div
            className="absolute top-1/2 left-1/2 h-2 w-2 rounded-sm bg-amber-400"
            style={{ animation: 'confetti3 0.9s ease-out 0.45s forwards' }}
          />
          <div
            className="absolute top-1/2 left-1/2 h-2 w-2 rounded-sm bg-emerald-400"
            style={{
              animation: 'confetti2 1s ease-out 0.55s forwards',
              animationDirection: 'reverse',
            }}
          />
          <div
            className="absolute top-1/2 left-1/2 h-2 w-2 rounded-sm bg-pink-400"
            style={{ animation: 'confetti1 1.2s ease-out 0.6s forwards' }}
          />
        </div>
      </div>

      {/* Heading */}
      <motion.h1
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.9 }}
        className="text-foreground mt-6 text-center text-xl font-semibold sm:text-2xl"
      >
        Application Received!
      </motion.h1>

      {/* Body text */}
      <motion.p
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, delay: 1.1 }}
        className="text-muted-foreground mx-auto mt-3 max-w-md text-center text-base"
      >
        Thanks for applying to become a Balo expert. We&apos;ve sent a confirmation to{' '}
        <span className="text-foreground font-medium">{email}</span>. Our team will review your
        application within 2&ndash;3 business days.
      </motion.p>

      {/* What happens next cards */}
      <div className="mx-auto mt-10 grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-3">
        {NEXT_STEPS.map((step, index) => (
          <motion.div
            key={step.label}
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.3, delay: 1.3 + index * 0.1 }}
            className="border-border bg-card rounded-xl border p-5 text-center"
          >
            <div className="bg-muted mx-auto mb-3 w-fit rounded-lg p-2">
              <step.icon className="text-muted-foreground h-8 w-8" aria-hidden="true" />
            </div>
            <p className="text-foreground text-sm font-semibold">{step.label}</p>
            <p className="text-muted-foreground mt-1 text-xs">{step.description}</p>
          </motion.div>
        ))}
      </div>

      {/* Primary CTA */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, delay: 1.8 }}
        className="mt-10"
      >
        <Button asChild size="lg">
          <Link href="/dashboard">
            Explore Balo as a Client
            <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      </motion.div>

      {/* Secondary link */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, delay: 2 }}
        className="mt-4"
      >
        <Button asChild variant="link">
          <Link href="/expert/apply/review">View your application</Link>
        </Button>
      </motion.div>
    </div>
  );
}
