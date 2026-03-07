'use client';

import { motion } from 'motion/react';
import { Video } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';

function SkeletonRow(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 opacity-[0.35]">
      {/* Time block placeholder */}
      <div className="bg-muted h-9 w-14 rounded-md" />
      {/* Accent bar */}
      <div className="bg-primary h-9 w-[3px] rounded-full" />
      {/* Content area */}
      <div className="flex-1 space-y-1.5">
        <div className="bg-muted h-3.5 w-32 rounded" />
        <div className="flex items-center gap-2">
          <div className="bg-muted h-5 w-5 rounded-full" />
          <div className="bg-muted h-3 w-20 rounded" />
        </div>
      </div>
      {/* Duration pill */}
      <div className="bg-muted h-6 w-12 rounded-full" />
    </div>
  );
}

export function GhostConsultationsCard(): React.JSX.Element {
  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.35, delay: 0.2, ease: 'easeOut' }}
      className="border-border bg-card relative overflow-hidden rounded-xl border"
    >
      {/* Card content */}
      <div className="p-6">
        {/* Title row */}
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-foreground text-sm font-semibold">Upcoming Consultations</h3>
          <span className="text-muted-foreground text-xs">Today</span>
        </div>

        {/* Skeleton rows */}
        <div className="space-y-4">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </div>

      {/* Frosted glass overlay */}
      <div className="bg-background/70 dark:bg-background/80 absolute inset-0 flex flex-col items-center justify-center backdrop-blur-[1px]">
        <IconBadge icon={Video} color="#2563EB" size={44} iconSize={22} className="mb-3" />
        <p className="text-foreground text-sm font-semibold">Complete setup to receive bookings</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Your upcoming sessions will appear here
        </p>
      </div>
    </motion.div>
  );
}
