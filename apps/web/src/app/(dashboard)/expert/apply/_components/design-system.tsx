'use client';

import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';

// ── Animation Variants ──────────────────────────────────────────

export const slideUpVariant = {
  initial: { y: 16, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  transition: { duration: 0.4, ease: 'easeOut' as const },
};

export const fadeInVariant = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.35, ease: 'easeOut' as const },
};

export const scaleInVariant = {
  initial: { scale: 0.95, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  transition: { duration: 0.2, ease: 'easeOut' as const },
};

export const slideInRightVariant = {
  initial: { x: 20, opacity: 0 },
  animate: { x: 0, opacity: 1 },
  transition: { duration: 0.3, ease: 'easeOut' as const },
};

export function stagger(index: number, base = 0.04): { transition: { delay: number } } {
  return { transition: { delay: index * base } };
}

// ── SectionLabel ────────────────────────────────────────────────

const SECTION_BG_MAP: Record<string, string> = {
  'text-primary': 'bg-primary/10',
  'text-violet-600': 'bg-violet-600/10',
  'text-cyan-600': 'bg-cyan-600/10',
  'text-amber-600': 'bg-amber-600/10',
  'text-emerald-600': 'bg-emerald-600/10',
  'text-pink-600': 'bg-pink-600/10',
  'text-indigo-600': 'bg-indigo-600/10',
};

interface SectionLabelProps {
  children: React.ReactNode;
  icon: LucideIcon;
  color?: string;
}

export function SectionLabel({
  children,
  icon: Icon,
  color = 'text-primary',
}: Readonly<SectionLabelProps>): React.JSX.Element {
  const bgClass = SECTION_BG_MAP[color] ?? 'bg-primary/10';

  return (
    <div className="mb-3.5 flex items-center gap-2">
      <div className={`flex h-6 w-6 items-center justify-center rounded-md ${bgClass}`}>
        <Icon className={`h-[13px] w-[13px] ${color}`} aria-hidden="true" />
      </div>
      <p className={`text-[11px] font-semibold tracking-[0.08em] uppercase ${color}`}>{children}</p>
    </div>
  );
}

// ── StepHeading ─────────────────────────────────────────────────

interface StepHeadingProps {
  icon: LucideIcon;
  iconColor?: string;
  iconBg?: string;
  iconBorder?: string;
  title: string;
  subtitle: string;
}

export function StepHeading({
  icon: Icon,
  iconColor = 'text-primary',
  iconBg = 'bg-primary/10',
  iconBorder = 'border-primary/25',
  title,
  subtitle,
}: Readonly<StepHeadingProps>): React.JSX.Element {
  return (
    <motion.div
      initial={slideUpVariant.initial}
      animate={slideUpVariant.animate}
      transition={slideUpVariant.transition}
      className="mb-8"
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-[10px] border ${iconBg} ${iconBorder}`}
        >
          <Icon className={`h-[18px] w-[18px] ${iconColor}`} aria-hidden="true" />
        </div>
        <h2 className="text-foreground text-[22px] font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="text-muted-foreground mt-1.5 ml-12 text-[13px]">{subtitle}</p>
    </motion.div>
  );
}
