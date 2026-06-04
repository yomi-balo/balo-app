'use client';

import { Zap, Clock, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import type { QuickStartSummary } from '@/components/expert/profile';

interface PackageCardProps {
  pkg: QuickStartSummary;
  onViewDetails: (id: string) => void;
}

/**
 * Presentational quick-start package card. NOT mounted in v1 (no package data
 * model yet — BAL-255 owns it). It is the explicit seam BAL-255 fills: fetch
 * real packages, pass them into `QuickStartsSection`, and wire `onViewDetails`
 * to open a `PackageDrawer` built on the shared `Drawer`.
 */
export function PackageCard({ pkg, onViewDetails }: Readonly<PackageCardProps>): React.JSX.Element {
  return (
    <motion.button
      type="button"
      onClick={() => onViewDetails(pkg.id)}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="border-border bg-card group flex w-full gap-4 rounded-[14px] border p-5 text-left shadow-sm transition-colors hover:border-violet-500/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-violet-500/40 focus-visible:outline-none"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400">
        <Zap className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-foreground m-0 text-[15px] font-semibold">{pkg.title}</h4>
          <span className="text-foreground shrink-0 text-base font-bold">{pkg.priceLabel}</span>
        </div>
        <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">{pkg.description}</p>
        <div className="mt-3 flex items-center gap-1.5">
          <Clock className="text-muted-foreground/70 h-3 w-3" aria-hidden="true" />
          <span className="text-muted-foreground/70 text-xs">{pkg.durationLabel}</span>
          <span className="ml-auto flex items-center gap-1 text-[13px] font-semibold text-violet-600 dark:text-violet-400">
            View details <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </motion.button>
  );
}
