'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { GettingStartedChecklist } from './getting-started-checklist';
import { CelebrationCard } from './celebration-card';
import { MetricCards } from './metric-cards';
import { GhostConsultationsCard } from './ghost-consultations-card';
import { GhostClientsCard } from './ghost-clients-card';
import { track, EXPERT_SETUP_EVENTS } from '@/lib/analytics';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

interface ExpertDashboardProps {
  checklistStatus: ChecklistStatus | null;
  userName: string;
}

export function ExpertDashboard({
  checklistStatus,
  userName,
}: ExpertDashboardProps): React.JSX.Element {
  const isAllComplete = checklistStatus?.allComplete ?? false;
  const prevItems = useRef<ChecklistStatus['items'] | null>(null);
  const prevAllComplete = useRef<boolean | null>(null);

  // Track setup step completion events
  useEffect(() => {
    if (!checklistStatus) return;

    const { completedCount, allComplete, items } = checklistStatus;

    // Detect individual step completions (only newly completed steps)
    if (prevItems.current !== null) {
      const itemKeys = CHECKLIST_ITEMS.map((item) => item.key);
      for (const key of itemKeys) {
        const wasComplete = prevItems.current[key as keyof typeof items];
        const isNowComplete = items[key as keyof typeof items];
        if (isNowComplete && !wasComplete) {
          const stepIndex = itemKeys.indexOf(key);
          track(EXPERT_SETUP_EVENTS.SETUP_STEP_COMPLETED, {
            step: key,
            step_number: stepIndex + 1,
            completed_count: completedCount,
            total: 6,
          });
        }
      }
    }

    // Detect all-complete transition
    if (prevAllComplete.current === false && allComplete) {
      track(EXPERT_SETUP_EVENTS.SETUP_ALL_COMPLETE, {});
    }

    prevItems.current = items;
    prevAllComplete.current = allComplete;
  }, [checklistStatus]);

  return (
    <div>
      {/* Page header */}
      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="mb-6"
      >
        <h2 className="text-foreground text-2xl font-semibold">Welcome back, {userName}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Here&apos;s what&apos;s happening with your expert account.
        </p>
      </motion.div>

      {/* Checklist or Celebration */}
      {checklistStatus &&
        (isAllComplete ? (
          <CelebrationCard />
        ) : (
          <GettingStartedChecklist status={checklistStatus} />
        ))}

      {/* Metric cards */}
      <MetricCards />

      {/* Ghost preview cards */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GhostConsultationsCard />
        <GhostClientsCard />
      </div>
    </div>
  );
}
