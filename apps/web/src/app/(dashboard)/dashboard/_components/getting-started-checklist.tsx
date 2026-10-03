'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import {
  User,
  DollarSign,
  Calendar,
  Clock,
  CreditCard,
  Pause,
  Sparkles,
  Check,
  ArrowRight,
} from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';
import { expertSettingsHrefFor } from '@/lib/constants/expert-checklist';
import type { LucideIcon } from 'lucide-react';

interface ChecklistItemUI {
  key: 'profile' | 'rate' | 'calendar' | 'availability' | 'payouts';
  icon: LucideIcon;
  color: string;
  label: string;
  description: string;
  tab: string;
}

const CHECKLIST_ITEMS_UI: ChecklistItemUI[] = [
  {
    key: 'profile',
    icon: User,
    color: '#2563EB',
    label: 'Complete your profile',
    description: 'Add your photo, headline, and bio',
    tab: 'profile',
  },
  {
    key: 'rate',
    icon: DollarSign,
    color: '#059669',
    label: 'Set your rate',
    description: 'Choose your per-minute consulting rate',
    tab: 'rate',
  },
  {
    key: 'calendar',
    icon: Calendar,
    color: '#7C3AED',
    label: 'Connect calendar',
    description: 'Sync to prevent double bookings',
    tab: 'schedule',
  },
  {
    key: 'availability',
    icon: Clock,
    color: '#0891B2',
    label: 'Set your availability',
    description: "Tell clients when you're free",
    tab: 'schedule',
  },
  {
    key: 'payouts',
    icon: CreditCard,
    color: '#D97706',
    label: 'Set up payouts',
    description: 'Connect Stripe to receive earnings',
    tab: 'payouts',
  },
];

/** Shown in place of the availability row while the expert has paused new work. */
const PAUSED_AVAILABILITY_UI: Pick<ChecklistItemUI, 'icon' | 'label' | 'description'> = {
  icon: Pause,
  label: 'Paused for new work',
  description: 'Turn availability back on in Schedule',
};

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { x: -12, opacity: 0 },
  visible: { x: 0, opacity: 1, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

interface GettingStartedChecklistProps {
  status: ChecklistStatus;
}

export function GettingStartedChecklist({
  status,
}: GettingStartedChecklistProps): React.JSX.Element {
  const router = useRouter();
  const { completedCount } = status;
  const progressPercent = (completedCount / 5) * 100;

  // Numbering counts only the rows still to do. The paused availability row is its own state,
  // neither done nor to do, so it takes no number and does not advance this count.
  // `completedCount` comes from the server derivation, unchanged by a pause.
  let incompleteIndex = 0;

  return (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.1, ease: 'easeOut' }}
      className="border-border bg-card mb-5 overflow-hidden rounded-xl border"
    >
      {/* Header section */}
      <div className="from-primary/5 dark:from-primary/10 bg-gradient-to-r to-purple-500/5 p-6 dark:to-purple-500/10">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <IconBadge icon={Sparkles} color="#7C3AED" size={36} iconSize={18} />
            <div>
              <h3 className="text-foreground text-base font-semibold">Getting Started</h3>
              <p className="text-muted-foreground text-sm">Complete these steps to go live</p>
            </div>
          </div>
          <div className="text-right">
            <span className="from-primary bg-gradient-to-r to-purple-500 bg-clip-text text-2xl font-semibold text-transparent tabular-nums">
              {completedCount}/5
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="bg-muted mt-4 h-2 overflow-hidden rounded-full">
          <div
            className="from-primary h-full rounded-full bg-gradient-to-r to-purple-500"
            style={{
              width: `${progressPercent}%`,
              animation: 'progressFill 0.6s ease-out',
            }}
          />
        </div>
      </div>

      {/* Checklist items */}
      <motion.div
        className="divide-border divide-y"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {CHECKLIST_ITEMS_UI.map((baseItem) => {
          // A paused expert is set up, not behind: the row stops nagging and says where to resume.
          const isPaused = baseItem.key === 'availability' && !status.availableForWork;
          const item = isPaused ? { ...baseItem, ...PAUSED_AVAILABILITY_UI } : baseItem;
          const isComplete = !isPaused && status.items[item.key];

          if (!isComplete && !isPaused) {
            incompleteIndex++;
          }
          const displayNumber = isComplete || isPaused ? null : incompleteIndex;

          return (
            <motion.button
              key={item.key}
              variants={itemVariants}
              onClick={() => router.push(expertSettingsHrefFor(item.key))}
              className="group hover:bg-muted/50 flex w-full items-center gap-4 px-6 py-4 text-left transition-colors"
            >
              {/* Completion circle or number */}
              {isPaused && <div aria-hidden="true" className="h-8 w-8 shrink-0" />}
              {isComplete && (
                <div
                  className="from-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-r to-purple-500"
                  style={{ animation: 'checkPop 0.3s ease-out' }}
                >
                  <Check className="h-4 w-4 text-white" />
                </div>
              )}
              {!isComplete && !isPaused && (
                <div className="border-border text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-medium">
                  {displayNumber}
                </div>
              )}

              {/* Icon badge */}
              <IconBadge
                icon={item.icon}
                color={item.color}
                size={36}
                iconSize={18}
                className={isComplete ? 'opacity-50' : ''}
              />

              {/* Label + description */}
              <div className="min-w-0 flex-1">
                <p
                  className={
                    isComplete
                      ? 'text-muted-foreground text-sm line-through'
                      : 'text-foreground text-sm font-medium'
                  }
                >
                  {item.label}
                </p>
                <p className="text-muted-foreground text-xs">{item.description}</p>
              </div>

              {/* Done badge, neutral Paused badge, or arrow */}
              {isComplete && <span className="text-success text-xs font-medium">Done</span>}
              {isPaused && (
                <span className="bg-paused-surface border-paused-border text-foreground/75 rounded-full border px-2 py-0.5 text-[11px] font-semibold">
                  Paused
                </span>
              )}
              {!isComplete && !isPaused && (
                <ArrowRight className="text-muted-foreground h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </motion.button>
          );
        })}
      </motion.div>
    </motion.div>
  );
}
