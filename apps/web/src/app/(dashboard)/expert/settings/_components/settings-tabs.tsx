'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { User, Shield, DollarSign, Calendar, CreditCard } from 'lucide-react';
import { TabPlaceholder } from './tab-placeholder';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

const SETTINGS_TABS = [
  { key: 'profile', label: 'Profile' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'rate', label: 'Rate' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'payouts', label: 'Payouts' },
] as const;

interface TabContentConfig {
  icon: LucideIcon;
  color: string;
  title: string;
  description: string;
  task: string;
}

const TAB_CONTENT: Record<string, TabContentConfig> = {
  profile: {
    icon: User,
    color: '#2563EB',
    title: 'Profile',
    description:
      'Manage how clients see you on the marketplace. Add your photo, headline, bio, and public profile URL.',
    task: 'BAL-192',
  },
  expertise: {
    icon: Shield,
    color: '#7C3AED',
    title: 'Expertise',
    description:
      'Your approved skills and self-assessment ratings. Locked after approval -- contact support for changes.',
    task: 'BAL-192',
  },
  rate: {
    icon: DollarSign,
    color: '#059669',
    title: 'Rate',
    description:
      "Set your per-minute consulting rate. Clients see a higher rate that includes Balo's service fee.",
    task: 'BAL-193',
  },
  schedule: {
    icon: Calendar,
    color: '#7C3AED',
    title: 'Schedule',
    description: 'Connect your calendars and set weekly availability for consultations.',
    task: 'BAL-194 / BAL-195',
  },
  payouts: {
    icon: CreditCard,
    color: '#D97706',
    title: 'Payouts',
    description: 'Connect your Stripe account to receive earnings from consultations.',
    task: 'BAL-196',
  },
};

interface SettingsTabsProps {
  defaultTab: string;
  setupStep: string | null;
}

export function SettingsTabs({ defaultTab, setupStep }: SettingsTabsProps): React.JSX.Element {
  const [tab, setTab] = useState(defaultTab);
  const router = useRouter();

  // Sync tab state when URL changes externally (browser back/forward, checklist click)
  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const handleTabChange = (key: string): void => {
    setTab(key);
    const params = new URLSearchParams();
    params.set('tab', key);
    if (setupStep) params.set('setup', setupStep);
    router.replace(`/expert/settings?${params.toString()}`, { scroll: false });
  };

  const content = TAB_CONTENT[tab] ?? TAB_CONTENT['profile'];
  if (!content) return <div />;

  return (
    <div>
      {/* Pill tab bar */}
      <div className="bg-muted mb-7 inline-flex gap-1 overflow-x-auto rounded-xl p-1">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={cn(
              'rounded-lg px-4 py-2 text-sm whitespace-nowrap transition-all duration-200',
              tab === t.key
                ? 'bg-card text-foreground font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <TabPlaceholder
            icon={content.icon}
            iconColor={content.color}
            title={content.title}
            description={content.description}
            task={content.task}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
