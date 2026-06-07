import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { calculateClientRate, centsToDollars } from '@/lib/utils/currency';
import type { ProfileSettingsData } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// The save actions `import 'server-only'` — must be mocked or the import throws.
vi.mock('../_actions/save-profile', () => ({
  saveProfileAction: vi.fn(),
}));
vi.mock('../_actions/save-country', () => ({
  saveCountryAction: vi.fn(),
}));

// Stub the heavy child components so the render stays light. We keep the rate
// computation (currency utils) REAL — that is the line under test.
vi.mock('./profile-form', () => ({
  ProfileForm: () => <div data-testid="profile-form" />,
}));
vi.mock('@/components/balo/phone-verification-flow', () => ({
  PhoneVerificationFlow: () => <div data-testid="phone-flow" />,
}));

// The preview panel is mocked to record the `expert` prop it receives so the
// test can assert the computed `rate` value. The rate line in ProfileTab feeds
// directly into `expert.rate`, so reading it here proves the line ran.
vi.mock('./profile-preview-panel', () => ({
  ProfilePreviewPanel: ({ expert }: { expert: { rate: number | null } }) => (
    <div data-testid="preview-rate">{String(expert.rate)}</div>
  ),
}));

import { ProfileTab } from './profile-tab';

// ── Fixture ──────────────────────────────────────────────────────

function makeProfile(rateCents: number | null): ProfileSettingsData {
  return {
    id: 'profile-1',
    headline: 'Salesforce Architect',
    bio: 'Building on the platform for a decade.',
    username: 'jane-doe',
    rateCents,
    availableForWork: true,
    yearStartedSalesforce: 2016,
    certifications: [],
    competencies: [],
    industries: [],
    languages: [],
    workHistory: [],
    user: {
      id: 'user-1',
      firstName: 'Jane',
      lastName: 'Doe',
      avatarUrl: null,
      timezone: 'Australia/Sydney',
      country: 'Australia',
      countryCode: 'AU',
    },
    // Remaining columns are not read by ProfileTab; cast covers the full type.
  } as unknown as ProfileSettingsData;
}

const REFERENCE_DATA = {
  languages: [],
  industries: [],
};

function renderTab(rateCents: number | null): void {
  render(
    <ProfileTab
      initialProfile={makeProfile(rateCents)}
      referenceData={REFERENCE_DATA}
      initialPhone={null}
      phoneVerifiedAt={null}
      accessToken="at_test"
    />
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe('ProfileTab — preview rate computation (line 143-144)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the client-marked-up dollar rate to the preview when rateCents is set', () => {
    renderTab(313);

    const expected = centsToDollars(calculateClientRate(313));
    // Sanity: the real utils compose to a positive dollar amount (313 * 1.25 / 100).
    expect(expected).toBeGreaterThan(0);
    expect(screen.getByTestId('preview-rate')).toHaveTextContent(String(expected));
  });

  it('passes null rate to the preview when rateCents is null', () => {
    renderTab(null);

    expect(screen.getByTestId('preview-rate')).toHaveTextContent('null');
  });
});
