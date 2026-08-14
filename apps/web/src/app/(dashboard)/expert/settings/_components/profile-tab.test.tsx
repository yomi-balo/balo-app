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
  ProfilePreviewPanel: ({
    expert,
  }: {
    expert: { rate: number | null; rating: number | null; ratingCount: number };
  }) => (
    <>
      <div data-testid="preview-rate">{String(expert.rate)}</div>
      <div data-testid="preview-rating">{String(expert.rating)}</div>
      <div data-testid="preview-review-count">{String(expert.ratingCount)}</div>
    </>
  ),
}));

import { ProfileTab } from './profile-tab';

// ── Fixture ──────────────────────────────────────────────────────

/**
 * ⚠ `rating` is `ratingAverage` from the RAW row, i.e. a `numeric` column that Drizzle hands
 * back as a STRING (`'4.3'`). The fixture mirrors that so `parseRatingAverage` is genuinely
 * exercised rather than bypassed by a pre-parsed number.
 */
function makeProfile(
  rateCents: number | null,
  rating: { ratingAverage: string | null; ratingCount: number } = {
    ratingAverage: null,
    ratingCount: 0,
  }
): ProfileSettingsData {
  return {
    id: 'profile-1',
    ...rating,
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

function renderTab(
  rateCents: number | null,
  rating?: { ratingAverage: string | null; ratingCount: number }
): void {
  render(
    <ProfileTab
      initialProfile={makeProfile(rateCents, rating)}
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

/**
 * BAL-422 — the self-preview must show the SAME badge clients see on the live card. It used
 * to hardcode `rating: null` / `ratingCount: 0`, which made the expert's own preview
 * misrepresent their live profile.
 */
describe('ProfileTab — preview rating aggregate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * ⚠ THE PARSE IS THE POINT. `rating_average` is `numeric`, so the row carries `'4.3'`; a
   * pass-through would put a STRING into a `number | null` field and `RatingBadge`'s
   * `.toFixed(1)` would throw at runtime while typechecking clean.
   */
  it('parses the numeric rating STRING into a number and passes the count through', () => {
    renderTab(313, { ratingAverage: '4.3', ratingCount: 2 });

    expect(screen.getByTestId('preview-rating')).toHaveTextContent('4.3');
    expect(screen.getByTestId('preview-review-count')).toHaveTextContent('2');
  });

  /** ⚠ NULL MEANS NO REVIEWS — never coalesced to 0, which would fabricate a bad score. */
  it('keeps an unrated expert null so the preview renders no badge', () => {
    renderTab(313, { ratingAverage: null, ratingCount: 0 });

    expect(screen.getByTestId('preview-rating')).toHaveTextContent('null');
    expect(screen.getByTestId('preview-review-count')).toHaveTextContent('0');
  });
});
