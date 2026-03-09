'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Calendar } from 'lucide-react';
import { TabPlaceholder } from './tab-placeholder';
import { RateTab } from './rate-tab';
import { PayoutsTab, type PayoutDetailsSummary } from './payouts-tab';
import { ProfileTab } from './profile-tab';
import { ExpertiseTab } from './expertise-tab';
import { WorkHistoryTab } from './work-history-tab';
import { CertificationsTab } from './certifications-tab';
import { cn } from '@/lib/utils';
import type {
  ProfileSettingsData,
  ApplicationCertWithRelations,
  CertificationsByCategory,
} from '@balo/db';

const SETTINGS_TABS = [
  { key: 'profile', label: 'Profile' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'workHistory', label: 'Work History' },
  { key: 'certifications', label: 'Certifications' },
  { key: 'rate', label: 'Rate' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'payouts', label: 'Payouts' },
] as const;

interface SettingsTabsProps {
  defaultTab: string;
  setupStep: string | null;
  initialRateCents: number | null;
  initialPayoutDetails: PayoutDetailsSummary | null;
  profileData: ProfileSettingsData | null;
  referenceData: {
    languages: Array<{ id: string; name: string; code: string; flagEmoji: string | null }>;
    industries: Array<{ id: string; name: string }>;
  } | null;
  certCategories: CertificationsByCategory[] | null;
}

export function SettingsTabs({
  defaultTab,
  setupStep,
  initialRateCents,
  initialPayoutDetails,
  profileData,
  referenceData,
  certCategories,
}: SettingsTabsProps): React.JSX.Element {
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

  return (
    <div>
      {/* Pill tab bar */}
      <div
        role="tablist"
        className="bg-muted mb-7 inline-flex gap-1 overflow-x-auto rounded-xl p-1"
      >
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
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
          role="tabpanel"
          key={tab}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          {tab === 'profile' && profileData && referenceData ? (
            <ProfileTab initialProfile={profileData} referenceData={referenceData} />
          ) : tab === 'profile' && (!profileData || !referenceData) ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertCircle className="text-muted-foreground mb-3 h-8 w-8" />
              <p className="text-muted-foreground text-sm">
                Failed to load profile data. Please refresh the page.
              </p>
            </div>
          ) : tab === 'expertise' && profileData ? (
            <div className="mx-auto max-w-[620px]">
              <ExpertiseTab skills={profileData.skills} skillsLocked={profileData.skillsLocked} />
            </div>
          ) : tab === 'workHistory' && profileData ? (
            <div className="mx-auto max-w-[620px]">
              <WorkHistoryTab initialEntries={profileData.workHistory} />
            </div>
          ) : tab === 'certifications' && profileData && certCategories ? (
            <div className="mx-auto max-w-[620px]">
              <CertificationsTab
                initialCerts={profileData.certifications as ApplicationCertWithRelations[]}
                certCategories={certCategories}
                trailheadUrl={profileData.trailheadUrl}
                skillsLocked={profileData.skillsLocked}
              />
            </div>
          ) : (tab === 'expertise' || tab === 'workHistory' || tab === 'certifications') &&
            !profileData ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertCircle className="text-muted-foreground mb-3 h-8 w-8" />
              <p className="text-muted-foreground text-sm">
                Failed to load profile data. Please refresh the page.
              </p>
            </div>
          ) : tab === 'rate' ? (
            <div className="mx-auto max-w-[620px]">
              <RateTab initialRateCents={initialRateCents} />
            </div>
          ) : tab === 'payouts' ? (
            <div className="mx-auto max-w-[620px]">
              <PayoutsTab initialPayoutDetails={initialPayoutDetails} />
            </div>
          ) : tab === 'schedule' ? (
            <div className="mx-auto max-w-[620px]">
              <TabPlaceholder
                icon={Calendar}
                iconColor="#7C3AED"
                title="Schedule"
                description="Connect your calendars and set weekly availability for consultations."
                task="BAL-194 / BAL-195"
              />
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
