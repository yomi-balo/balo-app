import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';

const {
  mockGetCurrentUser,
  mockRedirect,
  mockNotFound,
  mockFindApplicationForStaffReview,
  mockFindNamesByIds,
  mockGetSalesforceVertical,
  mockGetProductsByVertical,
  mockGetSupportTypes,
  mockGetCertificationsByVertical,
  mockHasPlatformCapability,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockFindApplicationForStaffReview: vi.fn(),
  mockFindNamesByIds: vi.fn(),
  mockGetSalesforceVertical: vi.fn(),
  mockGetProductsByVertical: vi.fn(),
  mockGetSupportTypes: vi.fn(),
  mockGetCertificationsByVertical: vi.fn(),
  mockHasPlatformCapability: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
/*
  FIX ROUND F2/F12 — the capability seam is MOCKED here on purpose.

  `review_expert_applications` and `view_platform_admin` are BOTH in `PLATFORM_STAFF_BUNDLE`, so
  with the real resolver NO `platformRole` string holds one without the other: a test that tried
  to separate the two arms by role would be vacuous by construction (the same defect F11 names).
  Mocking the seam is the only way to express "reaches the page, may NOT read the note" — the
  exact state the D5 bundle split will create. The default implementation delegates to the real
  map, so every other test in this file keeps its real-role behaviour.
*/
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/platform')>();
  return {
    ...actual,
    hasPlatformCapability: (...args: Parameters<typeof actual.hasPlatformCapability>): boolean =>
      mockHasPlatformCapability(...args),
  };
});
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/applications/11111111-1111-4111-8111-111111111111',
}));
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApplicationForStaffReview: (...a: unknown[]) => mockFindApplicationForStaffReview(...a),
  },
  usersRepository: {
    findNamesByIds: (...a: unknown[]) => mockFindNamesByIds(...a),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...a: unknown[]) => mockGetSalesforceVertical(...a),
    getProductsByVertical: (...a: unknown[]) => mockGetProductsByVertical(...a),
    getSupportTypes: (...a: unknown[]) => mockGetSupportTypes(...a),
    getCertificationsByVertical: (...a: unknown[]) => mockGetCertificationsByVertical(...a),
  },
}));

import { PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { platformRoleHasCapability } from '@balo/shared/authz';
import AdminApplicationReviewPage from './page';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  // Exclude `profile` from the outer spread below — it is merged field-by-field into the
  // `profile` object instead, so a raw `...overrides` here would clobber that merge.
  const restOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== 'profile')
  );
  return {
    profile: {
      id: PROFILE_ID,
      applicationStatus: 'submitted',
      submittedAt: new Date(Date.now() - 6 * 86_400_000),
      decidedAt: null,
      decidedByUserId: null,
      declineReason: null,
      declineNote: null,
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      linkedinUrl: null,
      trailheadUrl: null,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
      ...(overrides.profile as Record<string, unknown> | undefined),
    },
    user: {
      id: 'applicant-1',
      firstName: 'Priya',
      lastName: 'Shah',
      email: 'priya@example.com',
      avatarUrl: null,
      phone: null,
      timezone: null,
      country: null,
      countryCode: null,
      deletedAt: null,
    },
    agency: null,
    competencies: [],
    certifications: [],
    languages: [],
    industries: [],
    workHistory: [],
    ...restOverrides,
  };
}

async function renderPage(profileId: string = PROFILE_ID) {
  const ui = await AdminApplicationReviewPage({ params: Promise.resolve({ profileId }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  mockGetSalesforceVertical.mockResolvedValue({ id: 'vertical-1' });
  mockGetProductsByVertical.mockResolvedValue([]);
  mockGetSupportTypes.mockResolvedValue([]);
  mockGetCertificationsByVertical.mockResolvedValue([]);
  mockFindNamesByIds.mockResolvedValue([]);
  // Default: the REAL platform map, so the role-based tests below stay real.
  mockHasPlatformCapability.mockImplementation(
    (u: { platformRole: 'user' | 'admin' | 'super_admin' }, capability: string) =>
      platformRoleHasCapability(u.platformRole, capability as never)
  );
});

describe('AdminApplicationReviewPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockFindApplicationForStaffReview).not.toHaveBeenCalled();
  });

  it('notFound() for a viewer without VIEW_PLATFORM_ADMIN', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockFindApplicationForStaffReview).not.toHaveBeenCalled();
  });
});

describe('AdminApplicationReviewPage (RSC) — profileId validation', () => {
  it('notFound() for a non-uuid profileId, without touching the repository', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    await expect(renderPage('not-a-uuid')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockFindApplicationForStaffReview).not.toHaveBeenCalled();
  });
});

describe('AdminApplicationReviewPage (RSC) — staff render', () => {
  it('notFound() when the application does not exist', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders the decision controls for submitted AND for under_review', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    for (const status of ['submitted', 'under_review']) {
      const app = application({ profile: { applicationStatus: status } });
      mockFindApplicationForStaffReview.mockResolvedValue(app);
      const { unmount } = await renderPage();
      expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
      unmount();
    }
  });

  it('does NOT render the decision controls for an already-decided application', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        profile: {
          applicationStatus: 'approved',
          decidedAt: new Date('2026-01-01'),
          decidedByUserId: 'staff-1',
        },
      })
    );
    await renderPage();
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  it('renders the decline note on the STAFF page', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindNamesByIds.mockResolvedValue([{ id: 'staff-1', firstName: 'Dana', lastName: null }]);
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        profile: {
          applicationStatus: 'rejected',
          decidedAt: new Date('2026-01-01'),
          decidedByUserId: 'staff-1',
          declineReason: 'not_a_fit',
          declineNote: 'A staff-only note about this applicant.',
        },
      })
    );
    await renderPage();
    expect(screen.getByText('A staff-only note about this applicant.')).toBeInTheDocument();
    expect(screen.getByText(/Declined by Dana @ Balo/)).toBeInTheDocument();
  });

  /**
   * FIX ROUND F2/F12 — THE NOTE RENDER IS GATED SEPARATELY FROM THE PAGE READ.
   *
   * MUTATION-PROVEN: restore `declineNote={profile.declineNote}` on `page.tsx` and the
   * "withholds" arm below goes red.
   */
  it('withholds the decline note from a viewer who reaches the page WITHOUT review_expert_applications', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindNamesByIds.mockResolvedValue([{ id: 'staff-1', firstName: 'Dana', lastName: null }]);
    mockHasPlatformCapability.mockImplementation(
      (_u: unknown, capability: string) => capability === PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        profile: {
          applicationStatus: 'rejected',
          decidedAt: new Date('2026-01-01'),
          decidedByUserId: 'staff-1',
          declineReason: 'not_a_fit',
          declineNote: 'A staff-only note about this applicant.',
        },
      })
    );

    await renderPage();

    // The page itself still renders — VIEW_PLATFORM_ADMIN is what gates reaching it (D1).
    expect(screen.getByText(/Declined by Dana @ Balo/)).toBeInTheDocument();
    // …but the staff-only note is withheld.
    expect(screen.queryByText('A staff-only note about this applicant.')).toBeNull();
    expect(screen.queryByText(/Balo-only note/i)).toBeNull();
  });

  it('resolves REVIEW_EXPERT_APPLICATIONS for the note, not just the page token', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(application());
    await renderPage();

    expect(mockHasPlatformCapability).toHaveBeenCalledWith(
      expect.anything(),
      PLATFORM_CAPABILITIES.REVIEW_EXPERT_APPLICATIONS
    );
  });

  it('reads through findApplicationForStaffReview — the ONE method that carries the note', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(application());
    await renderPage();

    expect(mockFindApplicationForStaffReview).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('offers a mobile-safe way back to the queue', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(application());
    await renderPage();

    expect(screen.getByRole('link', { name: /back to applications/i })).toHaveAttribute(
      'href',
      '/admin/applications'
    );
  });

  it('renders the applicant header with email, agency (or Independent) and the waiting label', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(application());
    await renderPage();
    expect(screen.getByText(/priya@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Independent/)).toBeInTheDocument();
    expect(screen.getByText(/waiting 6d/)).toBeInTheDocument();
  });
});
