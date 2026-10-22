import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockFindPublicProfile = vi.fn();
const mockMapProfileToView = vi.fn();
const mockLoadBookingContext = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findPublicProfileByUsername: (...args: unknown[]) => mockFindPublicProfile(...args),
  },
}));
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));
vi.mock('@/lib/expert-profile/profile-view', () => ({
  mapProfileToView: (...args: unknown[]) => mockMapProfileToView(...args),
}));
vi.mock('../load-booking-context', () => ({
  loadBookingContext: (...args: unknown[]) => mockLoadBookingContext(...args),
}));
vi.mock('@/lib/logging', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    info: vi.fn(),
  },
}));

import { loadSearchBookingAction } from './load-search-booking';

const USER = { id: 'user-1', email: 'dana@northwind.com', onboardingCompleted: true };
const PROFILE = { id: 'profile-row' };
const VIEW = {
  expertId: 'expert-1',
  name: 'Anil Pilania',
  firstName: 'Anil',
  initials: 'AP',
  avatarKey: null,
  agency: { name: 'CloudPeak' },
  baloVerified: true,
  availableForWork: true,
  vertical: { slug: 'salesforce' },
  competencies: [{ id: 'product-1' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockFindPublicProfile.mockResolvedValue(PROFILE);
  mockMapProfileToView.mockReturnValue(VIEW);
  mockLoadBookingContext.mockResolvedValue({ arm: 'onboarding_required' });
});

describe('loadSearchBookingAction', () => {
  it('tells a signed-out visitor to sign in, before reading anything', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect(await loadSearchBookingAction({ username: 'anil' })).toEqual({
      ok: false,
      reason: 'signed_out',
    });
    expect(mockFindPublicProfile).not.toHaveBeenCalled();
  });

  it('rejects malformed input before reading the profile, and logs it', async () => {
    expect(await loadSearchBookingAction({ username: '' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(mockFindPublicProfile).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Search booking load rejected — invalid input',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('logs a failed profile read and reports the booking unavailable', async () => {
    mockFindPublicProfile.mockRejectedValue(new Error('connection reset'));
    expect(await loadSearchBookingAction({ username: 'anil' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Search booking profile fetch failed',
      expect.objectContaining({ username: 'anil', error: 'connection reset' })
    );
  });

  it('reports an unknown username unavailable', async () => {
    mockFindPublicProfile.mockResolvedValue(undefined);
    expect(await loadSearchBookingAction({ username: 'nobody' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(mockLoadBookingContext).not.toHaveBeenCalled();
  });

  it('reports a paused expert unavailable without reading the booking context', async () => {
    mockMapProfileToView.mockReturnValue({ ...VIEW, availableForWork: false });
    expect(await loadSearchBookingAction({ username: 'anil' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(mockLoadBookingContext).not.toHaveBeenCalled();
  });

  it("returns the expert, this user's booking context and email domain", async () => {
    mockLoadBookingContext.mockResolvedValue({
      arm: 'choose_company',
      viewerUserId: 'user-1',
      companies: [{ id: 'company-1', name: 'Northwind', logoUrl: null }],
      expert: { firstName: 'Anil', lastName: 'Pilania', partyLabel: 'CloudPeak' },
    });

    const result = await loadSearchBookingAction({ username: 'anil' });

    expect(mockFindPublicProfile).toHaveBeenCalledWith('anil');
    expect(mockMapProfileToView).toHaveBeenCalledWith(PROFILE);
    expect(mockLoadBookingContext).toHaveBeenCalledWith('expert-1', 'user-1');
    expect(result).toEqual({
      ok: true,
      expert: {
        expertProfileId: 'expert-1',
        name: 'Anil Pilania',
        firstName: 'Anil',
        initials: 'AP',
        avatarUrl: null,
        partyLabel: 'CloudPeak',
        verified: true,
        availableForWork: true,
        similarExpertsHref: expect.stringContaining('/experts?') as string,
      },
      context: {
        arm: 'choose_company',
        viewerUserId: 'user-1',
        companies: [{ id: 'company-1', name: 'Northwind', logoUrl: null }],
      },
      viewerEmailDomain: 'northwind.com',
    });
  });
});
