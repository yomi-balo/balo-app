'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Calendar, CreditCard, DollarSign, Globe, User } from 'lucide-react';
import { RateTab } from './rate-tab';
import { PayoutsTab, type PayoutDetailsSummary } from './payouts-tab';
import { ProfileTab } from './profile-tab';
import { ExpertiseTab } from './expertise-tab';
import { WorkHistoryTab } from './work-history-tab';
import { CertificationsTab } from './certifications-tab';
import { ScheduleTab } from './schedule-tab';
import { AgencyDomainsTab } from './agency-domains-tab';
import { cn } from '@/lib/utils';
import type {
  ProfileSettingsData,
  ApplicationCertWithRelations,
  CertificationsByCategory,
  PartyDomainWithCreator,
} from '@balo/db';

// ── Main tabs (pill strip) ──────────────────────────────────────
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

// ── Sub tabs (underline strip, under the Profile main tab) ──────
const PROFILE_SUB_TABS = [
  { key: 'profile', label: 'Profile' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'workHistory', label: 'Work History' },
  { key: 'certifications', label: 'Certifications' },
] as const;

// Sub-tab keys that live under the "Profile" main tab
const PROFILE_SUB_TAB_KEYS = new Set<string>(PROFILE_SUB_TABS.map((t) => t.key));

/**
 * The two levels read differently on purpose: the main row is a pill strip, the Profile sub-tab
 * row an underline strip.
 *
 * The underline strip's rule is an inset shadow, not a border, so each tab's 2px underline paints
 * over it from inside the scroll container: a `-mb-px` overhang past a border would be clipped by
 * `overflow-x-auto`, or scroll the strip by a pixel.
 *
 * `contain-inline-size` keeps a strip's unwrapped width out of its ancestors' min-content: the
 * dashboard shell's flex column has no `min-w-0`, so without it a strip wider than a 375px
 * viewport widens the whole page instead of scrolling. The pill is `inline-flex` (it hugs its
 * tabs), and inline-size containment would collapse a shrink-to-fit box to zero width — so the
 * pill carries the containment on a block wrapper and scrolls inside it at `max-w-full`.
 */
const UNDERLINE_STRIP_CLASSES =
  'scrollbar-none flex overflow-x-auto contain-inline-size shadow-[inset_0_-1px_0_var(--border)]';

const PILL_STRIP_CLASSES =
  'bg-muted scrollbar-none inline-flex max-w-full gap-1 overflow-x-auto rounded-xl p-1';

const PILL_TAB_CLASSES =
  'inline-flex items-center gap-1.5 rounded-lg px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors duration-200 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none sm:py-2';

const UNDERLINE_TAB_CLASSES =
  'border-b-2 font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset';

const INACTIVE_UNDERLINE_TAB_CLASSES =
  'text-muted-foreground hover:text-foreground border-transparent';

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
  canManageAgency,
  agencyDomains,
}: Readonly<SettingsTabsProps>): React.JSX.Element {
  const [tab, setTab] = useState(defaultTab);
  const router = useRouter();
  const idBase = useId();
  const mainTabs = canManageAgency ? [...MAIN_TABS, DOMAINS_TAB] : MAIN_TABS;

  // Sync tab state when URL changes externally (browser back/forward, checklist click)
  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const mainTab = getMainTab(tab);
  const subTab = getSubTab(tab);
  const showSubTabs = mainTab === 'profile';

  const mainTabId = (key: string): string => `${idBase}-tab-${key}`;
  const subTabId = (key: string): string => `${idBase}-subtab-${key}`;
  const panelId = `${idBase}-panel`;

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
      {/* ── Main tabs: pill strip — BAL-511 / ADR-1053 "tabs deliberately static" ── */}
      <div className={cn('contain-inline-size', showSubTabs ? 'mb-6' : 'mb-7')}>
        <div role="tablist" aria-label="Settings sections" className={PILL_STRIP_CLASSES}>
          {mainTabs.map((t) => {
            const Icon = t.icon;
            const isActive = mainTab === t.key;
            return (
              <button
                type="button"
                key={t.key}
                id={mainTabId(t.key)}
                role="tab"
                aria-selected={isActive}
                aria-controls={isActive ? panelId : undefined}
                onClick={() => handleMainTabChange(t.key)}
                className={cn(
                  PILL_TAB_CLASSES,
                  isActive
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon
                  className={cn('h-4 w-4', isActive ? 'text-primary' : 'text-muted-foreground')}
                  aria-hidden="true"
                />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Profile sub tabs ── */}
      {showSubTabs && (
        <div
          role="tablist"
          aria-label="Profile sections"
          className={cn(UNDERLINE_STRIP_CLASSES, 'mb-6 gap-5')}
        >
          {PROFILE_SUB_TABS.map((t) => {
            const isActive = subTab === t.key;
            return (
              <button
                type="button"
                key={t.key}
                id={subTabId(t.key)}
                role="tab"
                aria-selected={isActive}
                aria-controls={isActive ? panelId : undefined}
                onClick={() => handleTabChange(t.key)}
                className={cn(
                  UNDERLINE_TAB_CLASSES,
                  'px-0.5 py-3 text-[13.5px] sm:py-2',
                  isActive ? 'border-primary text-primary' : INACTIVE_UNDERLINE_TAB_CLASSES
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Tab content ── */}
      {/* ADR-1053 `tabs  … no panel fade`. A plain div: the new panel is in the DOM in the SAME
          commit as the state change, with no exit hold. ⚠ `key={tab}` STAYS — it is not
          decoration, it forces the same remount-per-tab semantics the earlier exit-hold
          implementation had, so no tab's subtree can inherit another's internal state. */}
      {/* `contain-inline-size` for the same reason as the strips: a panel's min-content (a
          schedule row, a long email) must not widen a phone-width page past the viewport. */}
      <div
        role="tabpanel"
        key={tab}
        id={panelId}
        aria-labelledby={showSubTabs ? subTabId(subTab) : mainTabId(mainTab)}
        className="contain-inline-size"
      >
        <TabPanelContent
          tab={tab}
          profileData={profileData}
          referenceData={referenceData}
          certCategories={certCategories}
          initialPhone={initialPhone}
          phoneVerifiedAt={phoneVerifiedAt}
          initialRateCents={initialRateCents}
          initialPayoutDetails={initialPayoutDetails}
          agencyDomains={agencyDomains}
        />
      </div>
    </div>
  );
}

/**
 * Panel widths. Every panel is left-aligned with the tab strip; only the width differs. The
 * Profile sub-tab builds its own two-column grid, so it takes the full container.
 */
const FORM_PANEL_CLASSES = 'max-w-[620px]';
const WIDE_PANEL_CLASSES = 'max-w-[860px]';

interface TabPanelContentProps {
  tab: string;
  profileData: ProfileSettingsData | null;
  referenceData: SettingsTabsProps['referenceData'];
  certCategories: CertificationsByCategory[] | null;
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
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
}: Readonly<TabPanelContentProps>): React.JSX.Element | null {
  if (tab === 'profile') {
    if (profileData && referenceData) {
      return (
        <ProfileTab
          initialProfile={profileData}
          referenceData={referenceData}
          initialPhone={initialPhone}
          phoneVerifiedAt={phoneVerifiedAt}
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
      <div className={FORM_PANEL_CLASSES}>
        <ExpertiseTab
          competencies={profileData.competencies}
          skillsLocked={profileData.skillsLocked}
        />
      </div>
    );
  }
  if (tab === 'workHistory') {
    return (
      <div className={FORM_PANEL_CLASSES}>
        <WorkHistoryTab initialEntries={profileData.workHistory} />
      </div>
    );
  }
  if (tab === 'certifications' && certCategories) {
    return (
      <div className={FORM_PANEL_CLASSES}>
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
      <div className={WIDE_PANEL_CLASSES}>
        <AgencyDomainsTab
          agencyId={agencyDomains.agencyId}
          partyName={agencyDomains.partyName}
          domains={agencyDomains.domains}
        />
      </div>
    );
  }

  if (PROFILE_SUB_TAB_KEYS.has(tab)) {
    return <ProfileSubTabContent {...props} />;
  }

  if (tab === 'rate') {
    return (
      <div className={FORM_PANEL_CLASSES}>
        <RateTab initialRateCents={initialRateCents} />
      </div>
    );
  }
  if (tab === 'payouts') {
    return (
      <div className={FORM_PANEL_CLASSES}>
        <PayoutsTab initialPayoutDetails={initialPayoutDetails} />
      </div>
    );
  }
  if (tab === 'schedule') {
    return (
      <div className={WIDE_PANEL_CLASSES}>
        <ScheduleTab />
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
