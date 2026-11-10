import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

const {
  mockFindEngagement,
  mockFindLive,
  mockFindLatestChoice,
  mockFindReviewer,
  mockFindCompany,
} = vi.hoisted(() => ({
  mockFindEngagement: vi.fn(),
  mockFindLive: vi.fn(),
  mockFindLatestChoice: vi.fn(),
  mockFindReviewer: vi.fn(),
  mockFindCompany: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  reviewsRepository: {
    findLive: (...a: unknown[]) => mockFindLive(...a),
    findLatestShowCompanyChoice: (...a: unknown[]) => mockFindLatestChoice(...a),
  },
  usersRepository: { findReviewerIdentityById: (...a: unknown[]) => mockFindReviewer(...a) },
  companiesRepository: { findReviewAttributionById: (...a: unknown[]) => mockFindCompany(...a) },
}));

import { buildReviewCaptureSeeds } from '@/test/fixtures/review-capture-seeds';
import { readEngagementReview } from './read-engagement-review';

const CREATED_AT = new Date('2026-07-12T09:30:00Z');
const EDITED_AT = new Date('2026-07-20T18:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    companyId: COMPANY_ID,
    engagementType: 'project',
  });
  mockFindReviewer.mockResolvedValue({ firstName: 'Sam', lastInitial: 'K', jobTitle: null });
  mockFindCompany.mockResolvedValue({
    name: 'Northwind Logistics',
    isPersonal: false,
    reviewNameHiddenAt: null,
    industryName: null,
  });
  mockFindLatestChoice.mockResolvedValue(undefined);
});

describe('readEngagementReview', () => {
  it('resolves the expert from the engagement, never from the caller', async () => {
    mockFindLive.mockResolvedValue(undefined);
    await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(mockFindLive).toHaveBeenCalledWith(ENGAGEMENT_ID, VIEWER_ID, EXPERT_PROFILE_ID);
  });

  it('returns the "none" state when the viewer has not rated yet', async () => {
    mockFindLive.mockResolvedValue(undefined);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toEqual({
      review: null,
      state: { kind: 'none' },
      capture: buildReviewCaptureSeeds(),
    });
  });

  it('resolves a 4 as rated_ok and projects only rating/body/date', async () => {
    mockFindLive.mockResolvedValue({
      id: 'review-1',
      rating: 4,
      body: 'Steady and clear',
      createdAt: CREATED_AT,
      lastEditedAt: null,
      reviewerUserId: VIEWER_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      reviewerRole: null,
      showCompany: false,
      bodyVisibility: 'private',
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toEqual({
      review: { rating: 4, body: 'Steady and clear', ratedOnIso: CREATED_AT.toISOString() },
      state: { kind: 'rated_ok', rating: 4 },
      capture: buildReviewCaptureSeeds({
        defaults: { showCompany: false, bodyVisibility: 'private' },
      }),
    });
    // The projection is an allow-list: no reviewer id, no expert id, no row internals.
    expect(Object.keys(result?.review ?? {}).sort()).toEqual(['body', 'ratedOnIso', 'rating']);
  });

  it('resolves a 3 as rated_low — the warm re-ask branch', async () => {
    mockFindLive.mockResolvedValue({
      rating: 3,
      body: null,
      createdAt: CREATED_AT,
      lastEditedAt: null,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.state).toEqual({ kind: 'rated_low', rating: 3 });
  });

  it('prefers last_edited_at over created_at for the "you rated on" date', async () => {
    mockFindLive.mockResolvedValue({
      rating: 5,
      body: null,
      createdAt: CREATED_AT,
      lastEditedAt: EDITED_AT,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.review?.ratedOnIso).toBe(EDITED_AT.toISOString());
  });

  it('returns undefined for a missing or soft-deleted engagement', async () => {
    mockFindEngagement.mockResolvedValue(undefined);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toBeUndefined();
    expect(mockFindLive).not.toHaveBeenCalled();
  });

  it('treats an out-of-range stored rating as "no review" rather than rendering it', async () => {
    mockFindLive.mockResolvedValue({
      rating: 9,
      body: 'impossible under review_rating_range',
      createdAt: CREATED_AT,
      lastEditedAt: null,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toEqual({
      review: null,
      state: { kind: 'none' },
      capture: buildReviewCaptureSeeds(),
    });
  });
});

describe('readEngagementReview — capture seeds', () => {
  it('reads the reviewer, company and last choice for the viewer and the engagement company', async () => {
    mockFindLive.mockResolvedValue(undefined);
    await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(mockFindReviewer).toHaveBeenCalledWith(VIEWER_ID);
    expect(mockFindCompany).toHaveBeenCalledWith(COMPANY_ID);
    expect(mockFindLatestChoice).toHaveBeenCalledWith(VIEWER_ID);
  });

  it('maps a case engagement to the "case" kind and carries the industry', async () => {
    mockFindLive.mockResolvedValue(undefined);
    mockFindEngagement.mockResolvedValue({
      id: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      companyId: COMPANY_ID,
      engagementType: 'case',
    });
    mockFindCompany.mockResolvedValue({
      name: 'Northwind Logistics',
      isPersonal: false,
      reviewNameHiddenAt: null,
      industryName: 'Logistics',
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.capture.identity).toEqual({
      engagementKind: 'case',
      reviewerFirstName: 'Sam',
      reviewerLastInitial: 'K',
      companyName: 'Northwind Logistics',
      companyNameAllowed: true,
      industryName: 'Logistics',
    });
  });

  it('defaults a first review from the saved job title and the last company choice', async () => {
    mockFindLive.mockResolvedValue(undefined);
    mockFindReviewer.mockResolvedValue({
      firstName: 'Sam',
      lastInitial: 'K',
      jobTitle: 'RevOps Lead',
    });
    mockFindLatestChoice.mockResolvedValue(false);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.capture.defaults).toEqual({
      role: 'RevOps Lead',
      showCompany: false,
      bodyVisibility: 'public',
    });
  });

  it('prefers the existing review values over the job title and the last choice', async () => {
    mockFindLive.mockResolvedValue({
      rating: 5,
      body: 'Lovely',
      createdAt: CREATED_AT,
      lastEditedAt: null,
      reviewerRole: 'CFO',
      showCompany: false,
      bodyVisibility: 'private',
    });
    mockFindReviewer.mockResolvedValue({
      firstName: 'Sam',
      lastInitial: 'K',
      jobTitle: 'RevOps Lead',
    });
    mockFindLatestChoice.mockResolvedValue(true);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.capture.defaults).toEqual({
      role: 'CFO',
      showCompany: false,
      bodyVisibility: 'private',
    });
  });

  it.each([
    ['a personal company', { isPersonal: true, reviewNameHiddenAt: null }],
    ['a company hidden from reviews', { isPersonal: false, reviewNameHiddenAt: CREATED_AT }],
  ])('marks %s as not allowed on reviews', async (_label, flags) => {
    mockFindLive.mockResolvedValue(undefined);
    mockFindCompany.mockResolvedValue({
      name: 'Sam Consulting',
      industryName: null,
      ...flags,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.capture.identity.companyNameAllowed).toBe(false);
  });

  it('fails closed when the reviewer or company cannot be read', async () => {
    mockFindLive.mockResolvedValue(undefined);
    mockFindReviewer.mockResolvedValue(undefined);
    mockFindCompany.mockResolvedValue(undefined);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.capture.identity).toEqual({
      engagementKind: 'project',
      reviewerFirstName: null,
      reviewerLastInitial: null,
      companyName: null,
      companyNameAllowed: false,
      industryName: null,
    });
    expect(result?.capture.defaults).toEqual({
      role: '',
      showCompany: true,
      bodyVisibility: 'public',
    });
  });
});
