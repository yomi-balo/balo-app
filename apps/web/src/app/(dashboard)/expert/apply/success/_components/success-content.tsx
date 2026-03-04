'use client';

import { Clock, Mail, Rocket, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

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

export function SuccessContent({ email }: SuccessContentProps): React.JSX.Element {
  return (
    <div className="relative flex flex-col items-center justify-center px-4 py-16">
      {/* Background glow */}
      <div
        className="bg-primary/15 dark:bg-primary/25 absolute top-1/4 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full blur-3xl"
        aria-hidden="true"
      />

      {/* Animated checkmark */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="bg-success/10 dark:bg-success/20 mx-auto flex h-20 w-20 items-center justify-center rounded-full"
      >
        <svg
          className="text-success h-10 w-10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <motion.path
            d="M5 13l4 4L19 7"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.6, ease: 'easeOut', delay: 0.2 }}
          />
        </svg>
      </motion.div>

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
        transition={{ duration: 0.2, delay: 2.0 }}
        className="mt-4"
      >
        <Button asChild variant="link">
          <Link href="/expert/apply">View your application</Link>
        </Button>
      </motion.div>
    </div>
  );
}
