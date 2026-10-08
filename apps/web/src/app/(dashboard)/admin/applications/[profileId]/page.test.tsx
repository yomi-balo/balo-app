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
  mockGetLanguages,
  mockGetIndustries,
  mockHasPlatformCapability,
  mockBuildStaffEditModel,
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
  mockGetLanguages: vi.fn(),
  mockGetIndustries: vi.fn(),
  mockHasPlatformCapability: vi.fn(),
  mockBuildStaffEditModel: vi.fn<(...a: unknown[]) => Record<string, unknown>>(() => ({})),
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
    getLanguages: (...a: unknown[]) => mockGetLanguages(...a),
    getIndustries: (...a: unknown[]) => mockGetIndustries(...a),
  },
}));

// Isolates this suite from the model-building logic — it pins what the PAGE passes to
// `buildStaffEditModel` and when, not the model it returns.
vi.mock('../_lib/staff-edit-model', () => ({
  buildStaffEditModel: (...a: unknown[]) => mockBuildStaffEditModel(...a),
}));

// `ApplicationReviewWorkspace` (this package's own file) is stubbed down to its OBSERVABLE
// surface — the props it was given — so this suite pins what the PAGE computes and passes
// (canEdit, isPending, banner, readSections, reference-data fetch timing), not the workspace's
// own save/cancel state machine, which `application-review-workspace.test.tsx` already covers.
vi.mock('../_components/application-review-workspace', () => ({
  ApplicationReviewWorkspace: (props: {
    canEdit: boolean;
    isPending: boolean;
    headerSummary: React.ReactNode;
    banner: React.ReactNode;
    readSections: React.ReactNode;
    workHistory: React.ReactNode;
  }) => (
    <div>
      {props.headerSummary}
      {props.canEdit && <button type="button">Edit application</button>}
      {props.isPending && <button type="button">Approve</button>}
      {props.banner}
      {props.readSections}
      {props.workHistory}
    </div>
  ),
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
      skillsLocked: false,
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
    selfRatings: [],
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
  mockGetLanguages.mockResolvedValue([]);
  mockGetIndustries.mockResolvedValue([]);
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

  /**
   * The self-rating overlay is gated the same way as the decline note: on
   * `REVIEW_EXPERT_APPLICATIONS`, not just the page's `VIEW_PLATFORM_ADMIN` token.
   */
  it('withholds self-ratings from a viewer who reaches the page WITHOUT review_expert_applications', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockHasPlatformCapability.mockImplementation(
      (_u: unknown, capability: string) => capability === PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    mockGetSupportTypes.mockResolvedValue([{ id: 'st-1', slug: 'config', name: 'Configuration' }]);
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        competencies: [
          {
            id: 'comp-1',
            expertProfileId: PROFILE_ID,
            productId: 'product-1',
            supportTypeId: 'st-1',
            proficiency: 5,
            product: { id: 'product-1', name: 'Sales Cloud' },
            supportType: { id: 'st-1', slug: 'config', name: 'Configuration' },
          },
        ],
        selfRatings: [{ productId: 'product-1', supportTypeId: 'st-1', selfProficiency: 8 }],
      })
    );

    await renderPage();

    expect(screen.queryByText('Self 8 →')).toBeNull();
    // `null`, not `[]`: this viewer must not see a false "Added by Balo" guess
    // for a product the expert DID self-rate.
    expect(screen.queryByText('Added by Balo')).toBeNull();
  });

  it('shows self-ratings for a reviewer with review_expert_applications', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockGetSupportTypes.mockResolvedValue([{ id: 'st-1', slug: 'config', name: 'Configuration' }]);
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        competencies: [
          {
            id: 'comp-1',
            expertProfileId: PROFILE_ID,
            productId: 'product-1',
            supportTypeId: 'st-1',
            proficiency: 5,
            product: { id: 'product-1', name: 'Sales Cloud' },
            supportType: { id: 'st-1', slug: 'config', name: 'Configuration' },
          },
        ],
        selfRatings: [{ productId: 'product-1', supportTypeId: 'st-1', selfProficiency: 8 }],
      })
    );

    await renderPage();

    expect(screen.getByText('Self 8 →')).toBeInTheDocument();
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

describe('AdminApplicationReviewPage (RSC) — BAL-593 edit affordance', () => {
  it('rejected → no "Edit application"', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        profile: {
          applicationStatus: 'rejected',
          decidedAt: new Date('2026-01-01'),
          decidedByUserId: 'staff-1',
          declineReason: 'not_a_fit',
        },
      })
    );
    await renderPage();
    expect(screen.queryByRole('button', { name: /edit application/i })).toBeNull();
  });

  it('approved with a null decidedAt → the unrecorded banner and Edit', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({ profile: { applicationStatus: 'approved', decidedAt: null } })
    );
    await renderPage();
    expect(screen.getByText('Approved, no decision record')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit application/i })).toBeInTheDocument();
  });

  it('a pending holder sees Edit application AND Approve/Decline', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({ profile: { applicationStatus: 'submitted' } })
    );
    await renderPage();
    expect(screen.getByRole('button', { name: /edit application/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
  });

  it('a VIEW_PLATFORM_ADMIN-only viewer sees no Edit application', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockHasPlatformCapability.mockImplementation(
      (_u: unknown, capability: string) => capability === PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({ profile: { applicationStatus: 'submitted' } })
    );
    await renderPage();
    expect(screen.queryByRole('button', { name: /edit application/i })).toBeNull();
  });

  it('fetches languages and industries only when canEdit', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({
        profile: {
          applicationStatus: 'rejected',
          decidedAt: new Date('2026-01-01'),
          decidedByUserId: 'staff-1',
          declineReason: 'not_a_fit',
        },
      })
    );
    await renderPage();
    expect(mockGetLanguages).not.toHaveBeenCalled();
    expect(mockGetIndustries).not.toHaveBeenCalled();
    expect(mockBuildStaffEditModel).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetSalesforceVertical.mockResolvedValue({ id: 'vertical-1' });
    mockGetProductsByVertical.mockResolvedValue([]);
    mockGetSupportTypes.mockResolvedValue([]);
    mockGetCertificationsByVertical.mockResolvedValue([]);
    mockGetLanguages.mockResolvedValue([]);
    mockGetIndustries.mockResolvedValue([]);
    mockHasPlatformCapability.mockImplementation(
      (u: { platformRole: 'user' | 'admin' | 'super_admin' }, capability: string) =>
        platformRoleHasCapability(u.platformRole, capability as never)
    );
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindApplicationForStaffReview.mockResolvedValue(
      application({ profile: { applicationStatus: 'submitted' } })
    );
    await renderPage();
    expect(mockGetLanguages).toHaveBeenCalledTimes(1);
    expect(mockGetIndustries).toHaveBeenCalledTimes(1);
    expect(mockBuildStaffEditModel).toHaveBeenCalledTimes(1);
  });
});
