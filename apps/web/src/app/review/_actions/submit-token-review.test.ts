import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const RAW_TOKEN = 'x2Fq7ZtQmA9pLd3Wc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const REVIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const { mockFindToken, mockFindEngagement, mockUpsert } = vi.hoisted(() => ({
  mockFindToken: vi.fn(),
  mockFindEngagement: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  reviewInviteTokensRepository: { findLiveByTokenHash: (...a: unknown[]) => mockFindToken(...a) },
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  reviewsRepository: { upsert: (...a: unknown[]) => mockUpsert(...a) },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    REVIEW_SERVER_EVENTS: events.REVIEW_SERVER_EVENTS,
  };
});

import { REVIEW_SUBMIT_FAILED } from '@/lib/reviews/messages';
import { submitTokenReviewAction } from './submit-token-review';

/** The resolved token row. `tokenHash` is a parameter so a mismatch case can force one. */
function tokenRow(tokenHash: string = TOKEN_HASH): Record<string, string> {
  return {
    id: 'token-row-1',
    engagementId: ENGAGEMENT_ID,
    reviewerUserId: REVIEWER_ID,
    tokenHash,
  };
}

function primeHappyPath(overrides: { engagementType?: string; created?: boolean } = {}): void {
  mockCheckLimit.mockReturnValue(true);
  mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
  mockFindToken.mockResolvedValue(tokenRow());
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    engagementType: overrides.engagementType ?? 'project',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockHasCapability.mockResolvedValue(true);
  mockUpsert.mockResolvedValue({ review: { id: 'review-1' }, created: overrides.created ?? true });
}

describe('submitTokenReviewAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the review with surface=email, authMethod=magic_link and the server-derived expert', async () => {
    primeHappyPath();

    const result = await submitTokenReviewAction({
      token: RAW_TOKEN,
      rating: 4,
      body: '  Genuinely helpful  ',
    });

    expect(result).toEqual({ success: true, created: true });
    expect(mockUpsert).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      reviewerUserId: REVIEWER_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      rating: 4,
      body: 'Genuinely helpful',
      surface: 'email',
      authMethod: 'magic_link',
    });
  });

  it('resolves the token by HASH — the raw token never reaches the repository', async () => {
    primeHappyPath();
    await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(mockFindToken).toHaveBeenCalledWith(TOKEN_HASH);
    expect(mockFindToken).not.toHaveBeenCalledWith(RAW_TOKEN);
  });

  it('takes expertProfileId from the ENGAGEMENT even when the caller tries to supply one', async () => {
    primeHappyPath();

    const result = await submitTokenReviewAction({
      token: RAW_TOKEN,
      rating: 5,
      // A hostile extra key: `.strict()` must reject the whole payload outright.
      expertProfileId: 'e0000000-0000-4000-8000-00000000dead',
    } as unknown as { token: string; rating: number });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('evaluates PARTICIPATE against the TOKEN SUBJECT and the engagement company', async () => {
    primeHappyPath();
    await submitTokenReviewAction({ token: RAW_TOKEN, rating: 3 });

    expect(mockHasCapability).toHaveBeenCalledWith({ id: REVIEWER_ID }, 'participate', {
      companyId: COMPANY_ID,
    });
  });

  it('denies when the reviewer no longer holds PARTICIPATE — opaque failure, NO upsert', async () => {
    primeHappyPath();
    mockHasCapability.mockResolvedValue(false);

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('denies the delivering expert naturally — no membership in the client company', async () => {
    primeHappyPath();
    // The expert holds no `company_members` row, so getMemberRole → undefined → false.
    mockHasCapability.mockResolvedValue(false);

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 1 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('returns the SAME opaque failure for an unknown / expired / revoked token', async () => {
    primeHappyPath();
    mockFindToken.mockResolvedValue(undefined);

    const missing = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    mockHasCapability.mockResolvedValue(false);
    mockFindToken.mockResolvedValue(tokenRow());
    const denied = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(missing).toEqual(denied);
    expect(missing).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
  });

  it('fails closed when the stored hash does not match the presented one', async () => {
    primeHappyPath();
    mockFindToken.mockResolvedValue(tokenRow('f'.repeat(64)));

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('applies BOTH rate-limit keys — one IP-scoped, one token-scoped', async () => {
    primeHappyPath();
    await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(mockCheckLimit).toHaveBeenCalledWith('review-submit-ip:1.2.3.4', {
      max: 10,
      windowMs: 60_000,
    });
    expect(mockCheckLimit).toHaveBeenCalledWith(`review-submit-tok:${TOKEN_HASH.slice(0, 16)}`, {
      max: 10,
      windowMs: 600_000,
    });
  });

  it('stops on the IP limiter BEFORE any database read', async () => {
    primeHappyPath();
    mockCheckLimit.mockReturnValueOnce(false);

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockFindToken).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('stops on the TOKEN limiter before any database read', async () => {
    primeHappyPath();
    mockCheckLimit.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockFindToken).not.toHaveBeenCalled();
  });

  it.each([0, 6, 2.5])('rejects rating %s without touching the database', async (rating) => {
    primeHappyPath();

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockFindToken).not.toHaveBeenCalled();
  });

  it('stores a whitespace-only body as NULL (the DB CHECK rejects blanks)', async () => {
    primeHappyPath();
    await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5, body: '   ' });

    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ body: null }));
  });

  it('tracks review_submitted on the insert branch, with has_body and no body text', async () => {
    primeHappyPath({ created: true });
    await submitTokenReviewAction({ token: RAW_TOKEN, rating: 4, body: 'Clear and calm' });

    expect(mockTrack).toHaveBeenCalledWith('review_submitted', {
      rating: 4,
      has_body: true,
      auth_method: 'magic_link',
      surface: 'email',
      engagement_kind: 'project',
      distinct_id: REVIEWER_ID,
    });
    const [, properties] = mockTrack.mock.calls[0] ?? [];
    expect(JSON.stringify(properties)).not.toContain('Clear and calm');
    expect(JSON.stringify(properties)).not.toContain(RAW_TOKEN);
  });

  it('tracks review_updated on the update branch', async () => {
    primeHappyPath({ created: false });
    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 2 });

    expect(result).toEqual({ success: true, created: false });
    expect(mockTrack).toHaveBeenCalledWith(
      'review_updated',
      expect.objectContaining({ rating: 2, has_body: false })
    );
  });

  it('carries the CASE engagement kind through to analytics', async () => {
    primeHappyPath({ engagementType: 'case' });
    await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(mockTrack).toHaveBeenCalledWith(
      'review_submitted',
      expect.objectContaining({ engagement_kind: 'case' })
    );
  });

  it('refuses a declared-but-unbuilt engagement type without writing', async () => {
    primeHappyPath({ engagementType: 'retainer' });

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('refuses when the engagement is gone, and never reaches the capability gate', async () => {
    primeHappyPath();
    mockFindEngagement.mockResolvedValue(undefined);

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockHasCapability).not.toHaveBeenCalled();
  });

  it('degrades a repository fault to the same opaque failure', async () => {
    primeHappyPath();
    mockUpsert.mockRejectedValue(new Error('connection terminated'));

    const result = await submitTokenReviewAction({ token: RAW_TOKEN, rating: 5 });

    expect(result).toEqual({ success: false, error: REVIEW_SUBMIT_FAILED });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
