'use client';

import { motion } from 'motion/react';
import { Users } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';

function ClientSkeletonRow(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 opacity-[0.35]">
      {/* Avatar circle */}
      <div className="bg-muted h-8 w-8 rounded-full" />
      {/* Name + company */}
      <div className="flex-1 space-y-1.5">
        <div className="bg-muted h-3.5 w-28 rounded" />
        <div className="bg-muted h-3 w-20 rounded" />
      </div>
      {/* Amount */}
      <div className="bg-muted h-4 w-16 rounded" />
    </div>
  );
}

export function GhostClientsCard(): React.JSX.Element {
  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.35, delay: 0.28, ease: 'easeOut' }}
      className="border-border bg-card relative overflow-hidden rounded-xl border"
    >
      {/* Card content */}
      <div className="p-6">
        {/* Title row */}
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-foreground text-sm font-semibold">Top Clients</h3>
          <span className="text-muted-foreground text-xs">All time</span>
        </div>

        {/* Skeleton rows */}
        <div className="space-y-4">
          <ClientSkeletonRow />
          <ClientSkeletonRow />
          <ClientSkeletonRow />
        </div>
      </div>

      {/* Frosted glass overlay */}
      <div className="bg-background/70 dark:bg-background/80 absolute inset-0 flex flex-col items-center justify-center backdrop-blur-[1px]">
        <IconBadge icon={Users} color="#7C3AED" size={44} iconSize={22} className="mb-3" />
        <p className="text-foreground text-sm font-semibold">Your top clients</p>
        <p className="text-muted-foreground mt-1 text-xs">Will appear after your first session</p>
      </div>
    </motion.div>
  );
}
