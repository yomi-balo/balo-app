'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Calendar,
  User,
  DollarSign,
  CreditCard,
  Shield,
  Briefcase,
  Award,
  Globe,
} from 'lucide-react';
import { RateTab } from './rate-tab';
import { PayoutsTab, type PayoutDetailsSummary } from './payouts-tab';
import { ProfileTab } from './profile-tab';
import { ExpertiseTab } from './expertise-tab';
import { WorkHistoryTab } from './work-history-tab';
import { CertificationsTab } from './certifications-tab';
import { CalendarTab } from './calendar-tab';
import { AgencyDomainsTab } from './agency-domains-tab';
import { cn } from '@/lib/utils';
import type {
  ProfileSettingsData,
  ApplicationCertWithRelations,
  CertificationsByCategory,
  PartyDomainWithCreator,
} from '@balo/db';

// ── Main tabs (pill style) ──────────────────────────────────────
const MAIN_TABS = [
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'rate', label: 'Rate', icon: DollarSign },
  { key: 'schedule', label: 'Schedule', icon: Calendar },
  { key: 'payouts', label: 'Payouts', icon: CreditCard },
] as const;

// BAL-347: the agency Domains tab is appended only for agency owners/admins.
const DOMAINS_TAB = { key: 'domains', label: 'Domains', icon: Globe } as const;

/** Agency-domains payload threaded through only when the expert can manage an agency. */
export interface AgencyDomainsTabData {
  agencyId: string;
  partyName: string;
  domains: PartyDomainWithCreator[] | null;
}

// ── Sub tabs (underline style, under Profile main tab) ──────────
const PROFILE_SUB_TABS = [
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'expertise', label: 'Expertise', icon: Shield },
  { key: 'workHistory', label: 'Work History', icon: Briefcase },
  { key: 'certifications', label: 'Certifications', icon: Award },
] as const;

// Sub-tab keys that live under the "Profile" main tab
const PROFILE_SUB_TAB_KEYS = new Set<string>(PROFILE_SUB_TABS.map((t) => t.key));

/** Derive which main tab is active from a URL tab value */
function getMainTab(tab: string): string {
  return PROFILE_SUB_TAB_KEYS.has(tab) ? 'profile' : tab;
}

/** Derive which sub tab is active when main tab is "profile" */
function getSubTab(tab: string): string {
  return PROFILE_SUB_TAB_KEYS.has(tab) ? tab : 'profile';
}

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
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
  accessToken: string;
  /** BAL-347: present + true only for agency owners/admins (adds the Domains tab). */
  canManageAgency: boolean;
  agencyDomains: AgencyDomainsTabData | null;
}

export function SettingsTabs({
  defaultTab,
  setupStep,
  initialRateCents,
  initialPayoutDetails,
  profileData,
  referenceData,
  certCategories,
  initialPhone,
  phoneVerifiedAt,
  accessToken,
  canManageAgency,
  agencyDomains,
}: SettingsTabsProps): React.JSX.Element {
  const [tab, setTab] = useState(defaultTab);
  const router = useRouter();
  const mainTabs = canManageAgency ? [...MAIN_TABS, DOMAINS_TAB] : MAIN_TABS;

  // Sync tab state when URL changes externally (browser back/forward, checklist click)
  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const mainTab = getMainTab(tab);
  const subTab = getSubTab(tab);

  const handleTabChange = (key: string): void => {
    setTab(key);
    const params = new URLSearchParams();
    params.set('tab', key);
    if (setupStep) params.set('setup', setupStep);
    router.replace(`/expert/settings?${params.toString()}`, { scroll: false });
  };

  const handleMainTabChange = (key: string): void => {
    // When switching to "profile" main tab, default to the "profile" sub tab
    handleTabChange(key === 'profile' ? 'profile' : key);
  };

  return (
    <div>
      {/* ── Main tabs (pill style with sliding indicator) ── */}
      <div
        role="tablist"
        aria-label="Settings sections"
        className="bg-muted relative mb-7 inline-flex gap-1 overflow-x-auto rounded-xl p-1"
      >
        {mainTabs.map((t) => {
          const Icon = t.icon;
          const isActive = mainTab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => handleMainTabChange(t.key)}
              className={cn(
                'relative z-10 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm whitespace-nowrap transition-colors duration-200',
                isActive
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="main-tab-pill"
                  className="bg-card absolute inset-0 rounded-lg shadow-sm"
                  transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
                />
              )}
              <Icon
                className={cn(
                  'relative z-10 h-4 w-4',
                  isActive ? 'text-primary' : 'text-muted-foreground'
                )}
                aria-hidden="true"
              />
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── Profile sub tabs (underline style) ── */}
      {mainTab === 'profile' && (
        <div
          role="tablist"
          aria-label="Profile sections"
          className="border-border mb-7 flex gap-0 overflow-x-auto border-b"
        >
          {PROFILE_SUB_TABS.map((t) => {
            const Icon = t.icon;
            const isActive = subTab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabChange(t.key)}
                className={cn(
                  '-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm whitespace-nowrap transition-all duration-150',
                  isActive
                    ? 'border-primary text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:border-border border-transparent'
                )}
              >
                <Icon
                  className={cn('h-4 w-4', isActive ? 'text-primary' : 'text-muted-foreground')}
                  aria-hidden="true"
                />
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Tab content ── */}
      <AnimatePresence mode="wait">
        <motion.div
          role="tabpanel"
          key={tab}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <TabPanelContent
            tab={tab}
            profileData={profileData}
            referenceData={referenceData}
            certCategories={certCategories}
            initialPhone={initialPhone}
            phoneVerifiedAt={phoneVerifiedAt}
            accessToken={accessToken}
            initialRateCents={initialRateCents}
            initialPayoutDetails={initialPayoutDetails}
            agencyDomains={agencyDomains}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

interface TabPanelContentProps {
  tab: string;
  profileData: ProfileSettingsData | null;
  referenceData: SettingsTabsProps['referenceData'];
  certCategories: CertificationsByCategory[] | null;
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
  accessToken: string;
  initialRateCents: number | null;
  initialPayoutDetails: PayoutDetailsSummary | null;
  agencyDomains: AgencyDomainsTabData | null;
}

/** Profile main-tab sub-content (profile / expertise / work-history / certifications). */
function ProfileSubTabContent({
  tab,
  profileData,
  referenceData,
  certCategories,
  initialPhone,
  phoneVerifiedAt,
  accessToken,
}: Readonly<TabPanelContentProps>): React.JSX.Element | null {
  if (tab === 'profile') {
    if (profileData && referenceData) {
      return (
        <ProfileTab
          initialProfile={profileData}
          referenceData={referenceData}
          initialPhone={initialPhone}
          phoneVerifiedAt={phoneVerifiedAt}
          accessToken={accessToken}
        />
      );
    }
    return <DataLoadError />;
  }

  // expertise / work-history / certifications all require the loaded profile.
  if (!profileData) {
    return <DataLoadError />;
  }

  if (tab === 'expertise') {
    return (
      <div className="mx-auto max-w-[620px]">
        <ExpertiseTab
          competencies={profileData.competencies}
          skillsLocked={profileData.skillsLocked}
        />
      </div>
    );
  }
  if (tab === 'workHistory') {
    return (
      <div className="mx-auto max-w-[620px]">
        <WorkHistoryTab initialEntries={profileData.workHistory} />
      </div>
    );
  }
  if (tab === 'certifications' && certCategories) {
    return (
      <div className="mx-auto max-w-[620px]">
        <CertificationsTab
          initialCerts={profileData.certifications as ApplicationCertWithRelations[]}
          certCategories={certCategories}
          trailheadUrl={profileData.trailheadUrl}
          skillsLocked={profileData.skillsLocked}
        />
      </div>
    );
  }
  return null;
}

/** Resolves the active tab to its content — flat early returns (no nested ternaries). */
function TabPanelContent(props: Readonly<TabPanelContentProps>): React.JSX.Element | null {
  const { tab, agencyDomains, initialRateCents, initialPayoutDetails } = props;

  if (tab === 'domains') {
    if (!agencyDomains) return null;
    return (
      <AgencyDomainsTab
        agencyId={agencyDomains.agencyId}
        partyName={agencyDomains.partyName}
        domains={agencyDomains.domains}
      />
    );
  }

  if (PROFILE_SUB_TAB_KEYS.has(tab)) {
    return <ProfileSubTabContent {...props} />;
  }

  if (tab === 'rate') {
    return (
      <div className="mx-auto max-w-[620px]">
        <RateTab initialRateCents={initialRateCents} />
      </div>
    );
  }
  if (tab === 'payouts') {
    return (
      <div className="mx-auto max-w-[620px]">
        <PayoutsTab initialPayoutDetails={initialPayoutDetails} />
      </div>
    );
  }
  if (tab === 'schedule') {
    return (
      <div className="mx-auto max-w-[620px]">
        <CalendarTab />
      </div>
    );
  }
  return null;
}

function DataLoadError(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <AlertCircle className="text-muted-foreground mb-3 h-8 w-8" />
      <p className="text-muted-foreground text-sm">
        Failed to load profile data. Please refresh the page.
      </p>
    </div>
  );
}
