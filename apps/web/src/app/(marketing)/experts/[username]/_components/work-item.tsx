'use client';

import { useState, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { WorkHistoryView } from '@/components/expert/profile';
import { cn } from '@/lib/utils';

interface WorkItemProps {
  item: WorkHistoryView;
  isLast: boolean;
}

/**
 * One role in the work timeline. Current roles default to expanded with an
 * accent dot + "Current" badge; past roles show their duration label and start
 * collapsed. `responsibilities` expands/collapses via a max-height transition.
 */
export function WorkItem({ item, isLast }: Readonly<WorkItemProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(item.isCurrent);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const hasDetail = item.responsibilities !== null && item.responsibilities.trim().length > 0;

  return (
    <div className="flex items-stretch gap-4">
      {/* Rail */}
      <div className="flex shrink-0 flex-col items-center pt-4">
        <span
          className={cn(
            'h-3.5 w-3.5 shrink-0 rounded-full border-[2.5px]',
            item.isCurrent
              ? 'border-violet-600 bg-violet-600 ring-4 ring-violet-600/10 dark:border-violet-400 dark:bg-violet-400'
              : 'border-border bg-card'
          )}
        />
        {!isLast && <span className="bg-border/60 mt-1 min-h-6 w-0.5 flex-1" />}
      </div>

      {/* Card */}
      <div className={cn('min-w-0 flex-1', isLast ? 'pb-0' : 'pb-3.5')}>
        <div className="border-border bg-card rounded-[14px] border p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-foreground m-0 text-base font-semibold">{item.role}</h4>
              <p className="text-primary mt-0.5 text-sm font-semibold">{item.company}</p>
              <p className="text-muted-foreground/70 mt-0.5 text-[13px]">{item.periodLabel}</p>
            </div>
            {item.isCurrent ? (
              <span className="border-success/30 bg-success/10 text-success inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold">
                <span className="bg-success h-1.5 w-1.5 rounded-full" /> Current
              </span>
            ) : (
              item.durationLabel && (
                <span className="bg-muted border-border/60 text-muted-foreground shrink-0 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium">
                  {item.durationLabel}
                </span>
              )
            )}
          </div>

          {hasDetail && (
            <>
              <motion.div
                initial={false}
                animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
                transition={reduce ? { duration: 0 } : { duration: 0.3, ease: 'easeInOut' }}
                className="overflow-hidden"
              >
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                  {item.responsibilities}
                </p>
              </motion.div>
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className="mt-0.5 -mb-2.5 flex min-h-11 items-center gap-1 py-2.5 text-[13px] font-semibold text-violet-600 focus-visible:ring-2 focus-visible:ring-violet-500/40 focus-visible:outline-none dark:text-violet-400"
              >
                {open ? 'View less' : 'View more'}
                <ChevronDown
                  className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
                />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
