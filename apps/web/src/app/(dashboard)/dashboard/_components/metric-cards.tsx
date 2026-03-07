'use client';

import { motion } from 'motion/react';
import { DollarSign, TrendingUp, Clock } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';
import type { LucideIcon } from 'lucide-react';

interface MetricItem {
  icon: LucideIcon;
  iconColor: string;
  label: string;
  value: string;
}

const METRICS: MetricItem[] = [
  {
    icon: DollarSign,
    iconColor: '#059669',
    label: 'Total earnings',
    value: 'A$0.00',
  },
  {
    icon: TrendingUp,
    iconColor: '#2563EB',
    label: 'This payout cycle',
    value: 'A$0.00',
  },
  {
    icon: Clock,
    iconColor: '#7C3AED',
    label: 'Pending transfer',
    value: 'A$0.00',
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

const cardVariants = {
  hidden: { y: 12, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.35, ease: 'easeOut' as const } },
};

export function MetricCards(): React.JSX.Element {
  return (
    <motion.div
      className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {METRICS.map((metric) => (
        <motion.div
          key={metric.label}
          variants={cardVariants}
          whileHover={{ y: -4 }}
          className="border-border bg-card rounded-xl border p-6 transition-shadow hover:shadow-lg"
        >
          <IconBadge icon={metric.icon} color={metric.iconColor} size={40} iconSize={20} />
          <p
            className="mt-3.5 font-mono text-[26px] font-bold tabular-nums"
            style={{ animation: 'numberPop 0.4s ease-out forwards' }}
          >
            {metric.value}
          </p>
          <span className="text-muted-foreground mt-1 text-sm">{metric.label}</span>
        </motion.div>
      ))}
    </motion.div>
  );
}
