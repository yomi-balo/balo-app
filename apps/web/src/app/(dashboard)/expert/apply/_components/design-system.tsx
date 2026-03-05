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

const SECTION_COLORS: Record<string, { text: string; bg: string }> = {
  primary: { text: '#2563EB', bg: 'rgba(37,99,235,0.1)' },
  violet: { text: '#7C3AED', bg: 'rgba(124,58,237,0.1)' },
  cyan: { text: '#0891B2', bg: 'rgba(8,145,178,0.1)' },
  amber: { text: '#D97706', bg: 'rgba(217,119,6,0.1)' },
  emerald: { text: '#059669', bg: 'rgba(5,150,105,0.1)' },
  pink: { text: '#DB2777', bg: 'rgba(219,39,119,0.1)' },
  indigo: { text: '#4F46E5', bg: 'rgba(79,70,229,0.1)' },
};

interface SectionLabelProps {
  children: React.ReactNode;
  icon: LucideIcon;
  color?: keyof typeof SECTION_COLORS;
}

export function SectionLabel({
  children,
  icon: Icon,
  color = 'primary',
}: Readonly<SectionLabelProps>): React.JSX.Element {
  const c = SECTION_COLORS[color] ?? SECTION_COLORS.primary;

  return (
    <div className="mb-3.5 flex items-center gap-2">
      <div
        className="flex h-6 w-6 items-center justify-center rounded-md"
        style={{ backgroundColor: c.bg }}
      >
        <Icon className="h-[13px] w-[13px]" style={{ color: c.text }} aria-hidden="true" />
      </div>
      <p
        className="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style={{ color: c.text }}
      >
        {children}
      </p>
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
