import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { calculateClientRate, centsToDollars } from '@/lib/utils/currency';
import type { ProfileSettingsData } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

const { refresh, saveProfileAction, saveCountryAction } = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveProfileAction: vi.fn(),
  saveCountryAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The save actions `import 'server-only'` — must be mocked or the import throws.
vi.mock('../_actions/save-profile', () => ({ saveProfileAction }));
vi.mock('../_actions/save-country', () => ({ saveCountryAction }));

interface StubFormProps {
  countryCode: string;
  onCountryChange: (code: string) => void;
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
  onPhoneVerified: (e164: string) => void;
  isDirty: boolean;
  onReset: () => void;
  onSave: () => void;
  isSaving: boolean;
}

// Stub the heavy form (it has its own suite) down to the props ProfileTab owns: the country
// baseline, the phone wiring, dirty state, and the save/reset handlers.
vi.mock('./profile-form', () => ({
  ProfileForm: (props: StubFormProps) => (
    <div
      data-testid="profile-form"
      data-country={props.countryCode}
      data-dirty={String(props.isDirty)}
      data-saving={String(props.isSaving)}
      data-initial-phone={props.initialPhone ?? ''}
      data-phone-verified-at={props.phoneVerifiedAt ?? ''}
    >
      <button type="button" onClick={() => props.onCountryChange('NZ')}>
        stub country NZ
      </button>
      <button type="button" onClick={() => props.onPhoneVerified('+64211234567')}>
        stub phone verified
      </button>
      <button type="button" onClick={props.onSave}>
        stub save
      </button>
      <button type="button" onClick={props.onReset}>
        stub reset
      </button>
    </div>
  ),
}));

// The preview panel is mocked to record the `expert` prop it receives so the
// test can assert the computed `rate` value. The rate line in ProfileTab feeds
// directly into `expert.rate`, so reading it here proves the line ran.
vi.mock('./profile-preview-panel', () => ({
  ProfilePreviewPanel: ({
    expert,
  }: {
    expert: {
      rate: number | null;
      rating: number | null;
      ratingCount: number;
      countryCode: string | null;
    };
  }) => (
    <div data-testid="preview-panel">
      <div data-testid="preview-rate">{String(expert.rate)}</div>
      <div data-testid="preview-rating">{String(expert.rating)}</div>
      <div data-testid="preview-review-count">{String(expert.ratingCount)}</div>
      <div data-testid="preview-country">{String(expert.countryCode)}</div>
    </div>
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
  },
  username = 'jane-doe'
): ProfileSettingsData {
  return {
    id: 'profile-1',
    ...rating,
    headline: 'Salesforce Architect',
    bio: 'Building on the platform for a decade.',
    username,
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
  rating?: { ratingAverage: string | null; ratingCount: number },
  phone: { initialPhone: string | null; phoneVerifiedAt: string | null } = {
    initialPhone: null,
    phoneVerifiedAt: null,
  },
  username?: string
): ReturnType<typeof render> {
  return render(
    <ProfileTab
      initialProfile={makeProfile(rateCents, rating, username)}
      referenceData={REFERENCE_DATA}
      initialPhone={phone.initialPhone}
      phoneVerifiedAt={phone.phoneVerifiedAt}
    />
  );
}

function form(): HTMLElement {
  return screen.getByTestId('profile-form');
}

beforeEach(() => {
  vi.clearAllMocks();
  saveProfileAction.mockResolvedValue({ success: true });
  saveCountryAction.mockResolvedValue({ success: true });
});

// ── Tests ────────────────────────────────────────────────────────

describe('ProfileTab — preview rate computation', () => {
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

describe('ProfileTab — layout', () => {
  it('lays the form and the preview out as a two-column grid from lg up', () => {
    const { container } = renderTab(313);

    const grid = container.firstElementChild;
    expect(grid?.className).toContain('lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]');
    expect(grid?.className).toContain('items-start');

    const desktopPreview = screen.getByTestId('preview-desktop');
    expect(desktopPreview.className).toContain('hidden');
    expect(desktopPreview.className).toContain('lg:block');
    expect(desktopPreview.className).toContain('lg:sticky');
    expect(desktopPreview).toContainElement(screen.getByTestId('preview-panel'));
    expect(
      form().compareDocumentPosition(desktopPreview) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('collapses the preview above the form on small screens', async () => {
    const user = userEvent.setup();
    renderTab(313);

    const toggle = screen.getByRole('button', { name: 'Show preview' });
    expect(toggle.closest('.lg\\:hidden')).not.toBeNull();
    expect(toggle.compareDocumentPosition(form()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('preview-panel')).toHaveLength(1);

    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide preview' })).toBeInTheDocument();
    expect(screen.getAllByTestId('preview-panel')).toHaveLength(2);
  });
});

describe('ProfileTab — phone', () => {
  it('hands the stored phone and its verification time to the form', () => {
    renderTab(313, undefined, {
      initialPhone: '+61406431059',
      phoneVerifiedAt: '2026-09-01T00:00:00.000Z',
    });

    expect(form()).toHaveAttribute('data-initial-phone', '+61406431059');
    expect(form()).toHaveAttribute('data-phone-verified-at', '2026-09-01T00:00:00.000Z');
  });

  it('confirms a verified number with a toast and refreshes the server data', async () => {
    const user = userEvent.setup();
    renderTab(313);

    await user.click(screen.getByRole('button', { name: 'stub phone verified' }));

    expect(toast.success).toHaveBeenCalledWith('Phone number verified');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileTab — save', () => {
  it('saves the profile alone when the country is unchanged', async () => {
    const user = userEvent.setup();
    renderTab(313);

    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Profile saved'));
    expect(saveProfileAction).toHaveBeenCalledWith({
      headline: 'Salesforce Architect',
      bio: 'Building on the platform for a decade.',
      username: 'jane-doe',
      industryIds: [],
      languages: [],
    });
    expect(saveCountryAction).not.toHaveBeenCalled();
    expect(form()).toHaveAttribute('data-saving', 'false');
  });

  it('seeds the form from the stored industries and languages', async () => {
    const user = userEvent.setup();
    const profile = {
      ...makeProfile(313),
      industries: [{ industryId: 'ind-fin' }],
      languages: [
        {
          languageId: 'lang-en',
          proficiency: 'native',
          language: { name: 'English', flagEmoji: '🇬🇧' },
        },
      ],
    } as unknown as ProfileSettingsData;
    render(
      <ProfileTab
        initialProfile={profile}
        referenceData={REFERENCE_DATA}
        initialPhone={null}
        phoneVerifiedAt={null}
      />
    );

    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() =>
      expect(saveProfileAction).toHaveBeenCalledWith(
        expect.objectContaining({
          industryIds: ['ind-fin'],
          languages: [{ languageId: 'lang-en', proficiency: 'native' }],
        })
      )
    );
  });

  it('treats a country change as unsaved, saves it, and moves the baseline', async () => {
    const user = userEvent.setup();
    renderTab(313);
    expect(form()).toHaveAttribute('data-dirty', 'false');

    await user.click(screen.getByRole('button', { name: 'stub country NZ' }));
    expect(form()).toHaveAttribute('data-country', 'NZ');
    expect(form()).toHaveAttribute('data-dirty', 'true');
    expect(screen.getByTestId('preview-country')).toHaveTextContent('NZ');

    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() => expect(saveCountryAction).toHaveBeenCalledWith({ countryCode: 'NZ' }));
    await waitFor(() => expect(form()).toHaveAttribute('data-dirty', 'false'));
    expect(form()).toHaveAttribute('data-country', 'NZ');
  });

  it('puts the saved country back on Reset', async () => {
    const user = userEvent.setup();
    renderTab(313);

    await user.click(screen.getByRole('button', { name: 'stub country NZ' }));
    await user.click(screen.getByRole('button', { name: 'stub reset' }));

    expect(form()).toHaveAttribute('data-country', 'AU');
    expect(form()).toHaveAttribute('data-dirty', 'false');
  });

  it('surfaces the first failed save and keeps the change unsaved', async () => {
    const user = userEvent.setup();
    saveCountryAction.mockResolvedValue({ success: false, error: 'Country not supported' });
    renderTab(313);

    await user.click(screen.getByRole('button', { name: 'stub country NZ' }));
    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Country not supported'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(form()).toHaveAttribute('data-dirty', 'true');
  });

  it('falls back to a generic message when a failure carries none', async () => {
    const user = userEvent.setup();
    saveProfileAction.mockResolvedValue({ success: false });
    renderTab(313);

    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save profile'));
  });

  it('reports a thrown save and clears the saving state', async () => {
    const user = userEvent.setup();
    saveProfileAction.mockRejectedValue(new Error('network'));
    renderTab(313);

    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to save profile. Please try again.')
    );
    expect(form()).toHaveAttribute('data-saving', 'false');
  });

  it('does not save when the form fails validation', async () => {
    const user = userEvent.setup();
    renderTab(313, undefined, undefined, 'ab');

    await user.click(screen.getByRole('button', { name: 'stub save' }));

    await waitFor(() => expect(form()).toHaveAttribute('data-saving', 'false'));
    expect(saveProfileAction).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
