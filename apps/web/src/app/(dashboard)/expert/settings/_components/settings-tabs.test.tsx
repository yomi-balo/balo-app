import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
vi.mock('./schedule-tab', () => ({ ScheduleTab: () => <div data-testid="schedule-tab" /> }));
vi.mock('./agency-domains-tab', () => ({
  AgencyDomainsTab: () => <div data-testid="agency-domains-tab" />,
}));

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
    expect(screen.getByTestId('schedule-tab')).toBeInTheDocument();
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

/**
 * BAL-511 / ADR-1053. The design reference's motion spec reads:
 *   `tabs  deliberately static — no underline slide, no panel fade, no press scale,
 *          uniform font-weight (animated tabs read as jitter here)`
 * `settings-tabs.tsx` predated the spec and was the pattern the calendar switcher wrongly copied
 * — the spec, not this file, is the precedent. Flattened here: no `layoutId`, no
 * `AnimatePresence`, one font weight per tab row.
 */
describe('SettingsTabs — deliberately static (ADR-1053, BAL-511)', () => {
  it('renders exactly one tabpanel', () => {
    renderTabs({ defaultTab: 'rate' });
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('puts the new panel in the DOM synchronously — no await, no findBy, no exit hold', () => {
    renderTabs({
      canManageAgency: true,
      agencyDomains: { agencyId: 'a1', partyName: 'Lattice', domains: [] },
    });
    // `fireEvent` (not `userEvent`) on purpose: it is fully synchronous, so a single expression
    // after it proves the panel swapped in the same commit. Under `AnimatePresence mode="wait"`
    // the outgoing panel is held for an extra commit and this fails.
    fireEvent.click(screen.getByRole('tab', { name: /domains/i }));
    expect(screen.getByTestId('agency-domains-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('rate-tab')).not.toBeInTheDocument();
  });

  // ⚠ Two tablists, one tabpanel. `getAllByRole('tab')` returns both rows' tabs, so each weight
  // test is scoped to its own tablist by name (BAL-511 D11).
  const fontClassesOf = (el: HTMLElement): string[] =>
    el.className.split(' ').filter((token) => token.startsWith('font-'));

  it('the main pill row carries ONE font weight, present and identical on both arms', () => {
    renderTabs({ defaultTab: 'rate' });
    const tablist = within(screen.getByRole('tablist', { name: 'Settings sections' }));
    const active = tablist.getByRole('tab', { name: /rate/i });
    const inactive = tablist.getByRole('tab', { name: /payouts/i });
    expect(fontClassesOf(active)).toEqual(['font-medium']);
    expect(fontClassesOf(inactive)).toEqual(fontClassesOf(active));
  });

  it('the profile sub-tab row carries ONE font weight, present and identical on both arms', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    const tablist = within(screen.getByRole('tablist', { name: 'Profile sections' }));
    const active = tablist.getByRole('tab', { name: /^profile$/i });
    const inactive = tablist.getByRole('tab', { name: /expertise/i });
    expect(fontClassesOf(active)).toEqual(['font-medium']);
    expect(fontClassesOf(inactive)).toEqual(fontClassesOf(active));
  });
});
