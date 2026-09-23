import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

vi.mock('server-only', () => ({}));

const mockGetChecklistStatus = vi.fn();
vi.mock('@/lib/actions/expert-checklist', () => ({
  getChecklistStatus: () => mockGetChecklistStatus(),
}));

const mockGetSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => mockGetSession() }));

const mockLogWarn = vi.fn();
vi.mock('@/lib/logging', () => ({ log: { warn: (...a: unknown[]) => mockLogWarn(...a) } }));

const mockFindPayouts = vi.fn();
const mockFindProfile = vi.fn();
const mockGetLanguages = vi.fn();
const mockGetIndustries = vi.fn();
const mockGetCerts = vi.fn();
const mockFindUser = vi.fn();
vi.mock('@balo/db', () => ({
  payoutsRepository: { findByExpertProfileId: (...a: unknown[]) => mockFindPayouts(...a) },
  expertsRepository: { findProfileForSettings: (...a: unknown[]) => mockFindProfile(...a) },
  referenceDataRepository: {
    getLanguages: () => mockGetLanguages(),
    getIndustries: () => mockGetIndustries(),
    getCertificationsByVertical: (...a: unknown[]) => mockGetCerts(...a),
  },
  usersRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
}));

const mockResolveAgencyDomainsTab = vi.fn();
vi.mock('./_lib/resolve-agency-domains-tab', () => ({
  resolveAgencyDomainsTab: (...a: unknown[]) => mockResolveAgencyDomainsTab(...a),
}));

// The chrome's two children, stubbed to expose exactly what the page hands them.
const tabsProps = vi.fn();
vi.mock('./_components/settings-tabs', () => ({
  SettingsTabs: (props: Record<string, unknown>) => {
    tabsProps(props);
    return <div data-testid="settings-tabs" />;
  },
}));
const bannerProps = vi.fn();
vi.mock('./_components/setup-banner', () => ({
  SetupBanner: (props: Record<string, unknown>) => {
    bannerProps(props);
    return <div data-testid="setup-banner" />;
  },
}));

import ExpertSettingsPage from './page';

const STATUS: ChecklistStatus = {
  items: {
    profile: true,
    phone: true,
    rate: true,
    calendar: true,
    availability: true,
    payouts: false,
  },
  completedCount: 5,
  allComplete: false,
  rateCents: 313,
  calendarNeedsReconnect: false,
};

const EXPERT_USER = { id: 'user-1', expertProfileId: 'ep-1', verticalId: 'v-1' };

async function renderPage(params: { tab?: string; setup?: string } = {}): Promise<void> {
  render(await ExpertSettingsPage({ searchParams: Promise.resolve(params) }));
}

function lastProps(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('component was not rendered');
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChecklistStatus.mockResolvedValue(STATUS);
  mockGetSession.mockResolvedValue({ user: EXPERT_USER });
  mockFindPayouts.mockResolvedValue(null);
  mockFindProfile.mockResolvedValue({ agencyId: null });
  mockGetLanguages.mockResolvedValue([
    { id: 'l1', name: 'English', code: 'en', flagEmoji: null, extra: 'dropped' },
  ]);
  mockGetIndustries.mockResolvedValue([{ id: 'i1', name: 'Retail', extra: 'dropped' }]);
  mockGetCerts.mockResolvedValue([]);
  mockFindUser.mockResolvedValue({ phone: '+61400000000', phoneVerifiedAt: null });
  mockResolveAgencyDomainsTab.mockResolvedValue({ canManageAgency: false, agencyDomains: null });
});

describe('ExpertSettingsPage — chrome', () => {
  it('puts the setup banner above the tabs, fed by the checklist the page already fetched', async () => {
    await renderPage({ tab: 'schedule' });

    const banner = screen.getByTestId('setup-banner');
    const tabs = screen.getByTestId('settings-tabs');
    expect(banner.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.parentElement).toHaveClass('flex', 'flex-col', 'gap-7');

    expect(mockGetChecklistStatus).toHaveBeenCalledTimes(1);
    expect(lastProps(bannerProps)).toEqual({
      status: STATUS,
      activeTab: 'schedule',
      setupStep: null,
    });
    expect(lastProps(tabsProps)).toMatchObject({ defaultTab: 'schedule', initialRateCents: 313 });
  });

  it('renders the tabs without a banner when the checklist cannot be read', async () => {
    mockGetChecklistStatus.mockRejectedValue(new Error('db down'));
    await renderPage({ tab: 'rate' });

    expect(screen.queryByTestId('setup-banner')).not.toBeInTheDocument();
    expect(lastProps(tabsProps)).toMatchObject({ defaultTab: 'rate', initialRateCents: null });
    expect(mockLogWarn).toHaveBeenCalledWith('Failed to fetch checklist status for settings', {
      error: 'db down',
    });
  });
});

describe('ExpertSettingsPage — tab + setup params', () => {
  it.each([
    [{}, 'profile'],
    [{ tab: 'bogus' }, 'profile'],
    [{ tab: 'payouts' }, 'payouts'],
    [{ tab: 'workHistory' }, 'workHistory'],
  ])('resolves %o to the %s tab for both the banner and the tabs', async (params, expected) => {
    await renderPage(params);
    expect(lastProps(bannerProps).activeTab).toBe(expected);
    expect(lastProps(tabsProps).defaultTab).toBe(expected);
  });

  it('coerces Domains back to Profile for an expert who cannot manage an agency', async () => {
    await renderPage({ tab: 'domains' });
    expect(lastProps(bannerProps).activeTab).toBe('profile');
    expect(lastProps(tabsProps)).toMatchObject({ defaultTab: 'profile', canManageAgency: false });
  });

  it('keeps Domains for an agency owner/admin', async () => {
    const agencyDomains = { agencyId: 'a1', partyName: 'Lattice', domains: [] };
    mockFindProfile.mockResolvedValue({ agencyId: 'a1' });
    mockResolveAgencyDomainsTab.mockResolvedValue({ canManageAgency: true, agencyDomains });
    await renderPage({ tab: 'domains' });

    expect(mockResolveAgencyDomainsTab).toHaveBeenCalledWith(EXPERT_USER, 'a1');
    expect(lastProps(bannerProps).activeTab).toBe('domains');
    expect(lastProps(tabsProps)).toMatchObject({
      defaultTab: 'domains',
      canManageAgency: true,
      agencyDomains,
    });
  });

  it('passes a valid setup step to both the banner and the tabs, and drops an unknown one', async () => {
    await renderPage({ tab: 'schedule', setup: 'calendar' });
    expect(lastProps(bannerProps).setupStep).toBe('calendar');
    expect(lastProps(tabsProps).setupStep).toBe('calendar');

    await renderPage({ tab: 'payouts', setup: 'nonsense' });
    expect(lastProps(bannerProps).setupStep).toBeNull();
    expect(lastProps(tabsProps).setupStep).toBeNull();
  });
});

describe('ExpertSettingsPage — settings data', () => {
  it('maps the loaded rows into the tabs’ props', async () => {
    const verifiedAt = new Date('2026-01-02T03:04:05.000Z');
    mockFindPayouts.mockResolvedValue({
      countryCode: 'AU',
      currency: 'AUD',
      transferMethod: 'LOCAL',
      entityType: 'PERSONAL',
      tradingName: null,
      formValues: { bsb: '000000' },
      verifiedAt,
      beneficiaryStatus: 'verified',
    });
    mockFindUser.mockResolvedValue({ phone: '+61400000000', phoneVerifiedAt: verifiedAt });
    await renderPage();

    expect(mockGetCerts).toHaveBeenCalledWith('v-1');
    expect(lastProps(tabsProps)).toMatchObject({
      initialPayoutDetails: {
        countryCode: 'AU',
        currency: 'AUD',
        transferMethod: 'LOCAL',
        entityType: 'PERSONAL',
        tradingName: null,
        formValues: { bsb: '000000' },
        verifiedAt: verifiedAt.toISOString(),
        beneficiaryStatus: 'verified',
      },
      profileData: { agencyId: null },
      referenceData: {
        languages: [{ id: 'l1', name: 'English', code: 'en', flagEmoji: null }],
        industries: [{ id: 'i1', name: 'Retail' }],
      },
      certCategories: [],
      initialPhone: '+61400000000',
      phoneVerifiedAt: verifiedAt.toISOString(),
    });
  });

  it('skips the certification read for an expert with no vertical', async () => {
    mockGetSession.mockResolvedValue({ user: { ...EXPERT_USER, verticalId: null } });
    await renderPage();
    expect(mockGetCerts).not.toHaveBeenCalled();
  });

  it('hands the tabs empty data for a session with no expert profile', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1', expertProfileId: null } });
    await renderPage();

    expect(mockFindProfile).not.toHaveBeenCalled();
    expect(lastProps(tabsProps)).toMatchObject({
      profileData: null,
      referenceData: null,
      initialPhone: null,
      canManageAgency: false,
    });
  });

  it('falls back to empty data when a settings read fails', async () => {
    mockFindProfile.mockRejectedValue(new Error('timeout'));
    await renderPage({ tab: 'rate' });

    expect(mockLogWarn).toHaveBeenCalledWith('Failed to fetch settings data', {
      error: 'timeout',
    });
    expect(lastProps(tabsProps)).toMatchObject({ defaultTab: 'rate', profileData: null });
    expect(screen.getByTestId('setup-banner')).toBeInTheDocument();
  });
});
