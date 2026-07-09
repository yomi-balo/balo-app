import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileSettingsData } from '@balo/db';

// Router (SettingsTabs replaces the URL on tab change).
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

// Stub the heavy child tabs with identifiable testids.
vi.mock('./rate-tab', () => ({ RateTab: () => <div data-testid="rate-tab" /> }));
vi.mock('./payouts-tab', () => ({ PayoutsTab: () => <div data-testid="payouts-tab" /> }));
vi.mock('./profile-tab', () => ({ ProfileTab: () => <div data-testid="profile-tab" /> }));
vi.mock('./expertise-tab', () => ({ ExpertiseTab: () => <div data-testid="expertise-tab" /> }));
vi.mock('./work-history-tab', () => ({
  WorkHistoryTab: () => <div data-testid="work-history-tab" />,
}));
vi.mock('./certifications-tab', () => ({
  CertificationsTab: () => <div data-testid="certifications-tab" />,
}));
vi.mock('./calendar-tab', () => ({ CalendarTab: () => <div data-testid="calendar-tab" /> }));
vi.mock('./agency-domains-tab', () => ({
  AgencyDomainsTab: () => <div data-testid="agency-domains-tab" />,
}));

// Stub motion to plain elements (JSDOM-friendly).
const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'variants', 'transition', 'layoutId']);
vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { SettingsTabs, type AgencyDomainsTabData } from './settings-tabs';

const PROFILE = {
  competencies: [],
  workHistory: [],
  certifications: [],
  skillsLocked: false,
  trailheadUrl: null,
} as unknown as ProfileSettingsData;

const REFERENCE = { languages: [], industries: [] };

interface RenderOptions {
  defaultTab?: string;
  canManageAgency?: boolean;
  agencyDomains?: AgencyDomainsTabData | null;
  profileData?: ProfileSettingsData | null;
  referenceData?: { languages: never[]; industries: never[] } | null;
  certCategories?: never[] | null;
}

function renderTabs(over: RenderOptions = {}): void {
  render(
    <SettingsTabs
      defaultTab={over.defaultTab ?? 'rate'}
      setupStep={null}
      initialRateCents={null}
      initialPayoutDetails={null}
      profileData={over.profileData ?? null}
      referenceData={over.referenceData ?? null}
      certCategories={over.certCategories ?? null}
      initialPhone={null}
      phoneVerifiedAt={null}
      accessToken=""
      canManageAgency={over.canManageAgency ?? false}
      agencyDomains={over.agencyDomains ?? null}
    />
  );
}

describe('SettingsTabs — content routing', () => {
  it('renders the ProfileTab when profile data is present', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    expect(screen.getByTestId('profile-tab')).toBeInTheDocument();
  });

  it('renders a data-load error when profile data is missing', () => {
    renderTabs({ defaultTab: 'profile', profileData: null });
    expect(screen.getByText(/failed to load profile data/i)).toBeInTheDocument();
  });

  it('renders the expertise / work-history / certifications sub-tabs with data', () => {
    renderTabs({ defaultTab: 'expertise', profileData: PROFILE, referenceData: REFERENCE });
    expect(screen.getByTestId('expertise-tab')).toBeInTheDocument();
  });

  it('renders a data-load error for a sub-tab without profile data', () => {
    renderTabs({ defaultTab: 'workHistory', profileData: null });
    expect(screen.getByText(/failed to load profile data/i)).toBeInTheDocument();
  });

  it('renders the certifications tab when categories are present', () => {
    renderTabs({ defaultTab: 'certifications', profileData: PROFILE, certCategories: [] });
    expect(screen.getByTestId('certifications-tab')).toBeInTheDocument();
  });

  it('renders the rate / payouts / schedule main tabs', () => {
    renderTabs({ defaultTab: 'rate' });
    expect(screen.getByTestId('rate-tab')).toBeInTheDocument();
    renderTabs({ defaultTab: 'payouts' });
    expect(screen.getByTestId('payouts-tab')).toBeInTheDocument();
    renderTabs({ defaultTab: 'schedule' });
    expect(screen.getByTestId('calendar-tab')).toBeInTheDocument();
  });
});

describe('SettingsTabs — agency Domains tab (BAL-347)', () => {
  it('does NOT show a Domains tab when the expert cannot manage an agency', () => {
    renderTabs({ canManageAgency: false });
    expect(screen.queryByRole('tab', { name: /domains/i })).not.toBeInTheDocument();
  });

  it('shows the Domains tab and renders AgencyDomainsTab when selected', async () => {
    const user = userEvent.setup();
    renderTabs({
      canManageAgency: true,
      agencyDomains: { agencyId: 'a1', partyName: 'Lattice', domains: [] },
    });

    const domainsTab = screen.getByRole('tab', { name: /domains/i });
    expect(domainsTab).toBeInTheDocument();

    await user.click(domainsTab);
    expect(screen.getByTestId('agency-domains-tab')).toBeInTheDocument();
  });
});
