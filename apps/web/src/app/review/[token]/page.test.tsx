import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { render, screen } from '@/test/utils';

const RAW_TOKEN = 'x2Fq7ZtQmA9pLd3Wc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const TOKEN_ROW_ID = 'f0000000-0000-4000-8000-00000000000f';
const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const REVIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

const {
  mockFindToken,
  mockRecordAccess,
  mockFindEngagement,
  mockContext,
  mockFindLive,
  mockUpsert,
} = vi.hoisted(() => ({
  mockFindToken: vi.fn(),
  mockRecordAccess: vi.fn(),
  mockFindEngagement: vi.fn(),
  mockContext: vi.fn(),
  mockFindLive: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  reviewInviteTokensRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindToken(...a),
    recordAccess: (...a: unknown[]) => mockRecordAccess(...a),
  },
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  reviewsRepository: {
    findLandingContext: (...a: unknown[]) => mockContext(...a),
    findLive: (...a: unknown[]) => mockFindLive(...a),
    // Present ONLY so the never-writes assertion has something to observe. Nothing on
    // this page may ever call it.
    upsert: (...a: unknown[]) => mockUpsert(...a),
  },
}));

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

const mockForm = vi.fn();
vi.mock('./_components/review-form', () => ({
  ReviewForm: (props: unknown) => {
    mockForm(props);
    return <div data-testid="review-form" />;
  },
}));

import ReviewLandingPage from './page';

/** ⚠ NO IDS — see `ReviewLandingContext`. The form's only identity field is the token. */
const LANDING_CONTEXT = {
  engagementKind: 'case' as const,
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak Consulting',
  expertGivenName: 'Amara',
  reviewerFirstName: 'Dana',
  title: 'Flow interview stuck on a record-triggered loop',
  concludedOnIso: '2026-08-03T00:00:00.000Z',
};

/** ⚠ BOTH are Promises — apps/web is Next 16. A plain object here would false-green. */
function pageProps(
  token = RAW_TOKEN,
  search: { r?: string | string[] } = {}
): { params: Promise<{ token: string }>; searchParams: Promise<{ r?: string | string[] }> } {
  return { params: Promise.resolve({ token }), searchParams: Promise.resolve(search) };
}

function primeHappyPath(): void {
  mockCheckLimit.mockReturnValue(true);
  mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
  mockFindToken.mockResolvedValue({
    id: TOKEN_ROW_ID,
    engagementId: ENGAGEMENT_ID,
    reviewerUserId: REVIEWER_ID,
    tokenHash: TOKEN_HASH,
  });
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    engagementType: 'case',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    baloFeeBps: 2500,
  });
  mockHasCapability.mockResolvedValue(true);
  mockContext.mockResolvedValue(LANDING_CONTEXT);
  mockFindLive.mockResolvedValue(undefined);
  mockRecordAccess.mockResolvedValue(undefined);
}

async function renderPage(props = pageProps()): Promise<HTMLElement> {
  const { container } = render(await ReviewLandingPage(props));
  return container;
}

beforeEach(() => vi.clearAllMocks());

describe('ReviewLandingPage', () => {
  it('renders the prefilled form for a live token', async () => {
    primeHappyPath();
    await renderPage(pageProps(RAW_TOKEN, { r: '5' }));

    expect(screen.getByTestId('review-form')).toBeInTheDocument();
    expect(mockForm).toHaveBeenCalledWith(
      expect.objectContaining({ token: RAW_TOKEN, prefill: 5, existing: null })
    );
  });

  it('hands the client component the DECLARED landing context and nothing else', async () => {
    primeHappyPath();
    await renderPage();

    const [props] = mockForm.mock.calls[0] ?? [];
    const context = (props as { context: Record<string, unknown> }).context;
    expect(context).toEqual(LANDING_CONTEXT);
    // The full supertype row is read for `company_id` only — its money column and the
    // engagement row itself must never reach the client.
    expect(JSON.stringify(props)).not.toContain('baloFeeBps');
    expect(JSON.stringify(props)).not.toContain('2500');
    // …and no ids ride along either: the token is the ONLY identity the client holds.
    expect(context).not.toHaveProperty('engagementId');
    expect(context).not.toHaveProperty('expertProfileId');
    expect(JSON.stringify(context)).not.toContain(ENGAGEMENT_ID);
    expect(JSON.stringify(context)).not.toContain(EXPERT_PROFILE_ID);
  });

  // ── THE ACCEPTANCE CRITERION ────────────────────────────────────────────────
  it('NEVER writes on GET — 20 prefilled loads produce ZERO upserts', async () => {
    primeHappyPath();

    for (let i = 0; i < 20; i += 1) {
      await renderPage(pageProps(RAW_TOKEN, { r: '5' }));
    }

    expect(mockUpsert).toHaveBeenCalledTimes(0);
    // The page did do its (idempotent, capped) job 20 times, so this is not vacuous.
    expect(mockContext).toHaveBeenCalledTimes(20);
  });

  it('resolves the token by HASH — the raw token never reaches the repository', async () => {
    primeHappyPath();
    await renderPage();

    expect(mockFindToken).toHaveBeenCalledWith(TOKEN_HASH);
    expect(mockFindToken).not.toHaveBeenCalledWith(RAW_TOKEN);
  });

  it('evaluates PARTICIPATE against the TOKEN SUBJECT and the engagement company', async () => {
    primeHappyPath();
    await renderPage();

    expect(mockHasCapability).toHaveBeenCalledWith({ id: REVIEWER_ID }, 'participate', {
      companyId: COMPANY_ID,
    });
  });

  it('stamps the access only AFTER every bail-out has been cleared', async () => {
    primeHappyPath();
    await renderPage();

    expect(mockRecordAccess).toHaveBeenCalledWith(TOKEN_ROW_ID);
  });

  it('passes an existing review through so the already-rated disclosure can render', async () => {
    primeHappyPath();
    mockFindLive.mockResolvedValue({
      rating: 3,
      body: 'Half of it landed',
      createdAt: new Date('2026-07-12T00:00:00Z'),
      lastEditedAt: null,
    });

    await renderPage();

    expect(mockForm).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: {
          rating: 3,
          body: 'Half of it landed',
          ratedOnIso: '2026-07-12T00:00:00.000Z',
        },
      })
    );
  });

  it.each([
    ['9', 'out of range'],
    ['abc', 'non-numeric'],
    ['3.5', 'fractional'],
    ['<script>', 'hostile'],
  ])('renders the no-rating state for ?r=%s (%s)', async (raw) => {
    primeHappyPath();
    await renderPage(pageProps(RAW_TOKEN, { r: raw }));

    expect(mockForm).toHaveBeenCalledWith(expect.objectContaining({ prefill: null }));
  });

  it('prefills nothing when ?r arrives repeated (an array) — genuinely ambiguous', async () => {
    primeHappyPath();
    await renderPage(pageProps(RAW_TOKEN, { r: ['1', '5'] }));

    expect(mockForm).toHaveBeenCalledWith(expect.objectContaining({ prefill: null }));
  });

  it('stops at the limiter BEFORE hashing, reading, or gating', async () => {
    primeHappyPath();
    mockCheckLimit.mockReturnValue(false);

    await renderPage();

    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockFindToken).not.toHaveBeenCalled();
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockRecordAccess).not.toHaveBeenCalled();
  });

  it('renders BYTE-IDENTICAL markup for every inactive outcome — no oracle', async () => {
    const markup: string[] = [];

    primeHappyPath();
    mockCheckLimit.mockReturnValue(false);
    markup.push((await renderPage()).innerHTML);

    primeHappyPath();
    mockFindToken.mockResolvedValue(undefined);
    markup.push((await renderPage()).innerHTML);

    primeHappyPath();
    mockFindToken.mockResolvedValue({
      id: TOKEN_ROW_ID,
      engagementId: ENGAGEMENT_ID,
      reviewerUserId: REVIEWER_ID,
      tokenHash: 'f'.repeat(64),
    });
    markup.push((await renderPage()).innerHTML);

    primeHappyPath();
    mockFindEngagement.mockResolvedValue(undefined);
    markup.push((await renderPage()).innerHTML);

    primeHappyPath();
    mockHasCapability.mockResolvedValue(false);
    markup.push((await renderPage()).innerHTML);

    primeHappyPath();
    mockContext.mockResolvedValue(undefined);
    markup.push((await renderPage()).innerHTML);

    expect(markup).toHaveLength(6);
    expect(new Set(markup).size).toBe(1);
    expect(markup[0]).toContain("This link isn't active");
    // …and none of the six rendered the form.
    expect(mockForm).not.toHaveBeenCalled();
  });

  it('never stamps an access on a bail-out', async () => {
    primeHappyPath();
    mockHasCapability.mockResolvedValue(false);

    await renderPage();

    expect(mockRecordAccess).not.toHaveBeenCalled();
  });

  it('is noindex with a neutral title that names nobody', async () => {
    const { metadata } = await import('./page');

    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Leave a review — Balo');
    expect(String(metadata.title)).not.toContain('Northwind');
  });
});
