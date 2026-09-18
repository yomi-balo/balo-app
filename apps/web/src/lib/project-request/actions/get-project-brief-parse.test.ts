import { describe, it, expect, vi, beforeEach } from 'vitest';

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

const mockFindForOwner = vi.fn();
vi.mock('@balo/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@balo/db')>();
  return {
    ...actual,
    projectBriefParsesRepository: {
      findForOwner: (...args: unknown[]) => mockFindForOwner(...args),
    },
  };
});

const mockLoadTaxonomies = vi.fn();
vi.mock('@/lib/project-request/load-project-taxonomy', () => ({
  loadProjectRequestTaxonomies: (...args: unknown[]) => mockLoadTaxonomies(...args),
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { getProjectBriefParseAction } from './get-project-brief-parse';

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARSE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const emptyTaxonomy = { groups: [] };

describe('getProjectBriefParseAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, onboardingCompleted: true, companyId: COMPANY_ID } };
    mockLoadTaxonomies.mockResolvedValue({
      tags: emptyTaxonomy,
      products: emptyTaxonomy,
      loadFailed: false,
    });
  });

  it('a cross-tenant id (row not found for this owner) resolves to not_found — never distinguished from absent', async () => {
    mockFindForOwner.mockResolvedValue(undefined);
    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result).toEqual({ status: 'failed', failureReason: 'not_found' });
  });

  it('a still-pending row within the deadline reports pending', async () => {
    mockFindForOwner.mockResolvedValue({
      id: PARSE_ID,
      result: null,
      failureReason: null,
      completedAt: null,
      createdAt: new Date(),
    });
    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result).toEqual({ status: 'pending' });
  });

  it('a pending row past PARSE_DEADLINE_MS DERIVES timed_out (never stored)', async () => {
    mockFindForOwner.mockResolvedValue({
      id: PARSE_ID,
      result: null,
      failureReason: null,
      completedAt: null,
      createdAt: new Date(Date.now() - 4 * 60 * 1000),
    });
    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result).toEqual({ status: 'failed', failureReason: 'timed_out' });
  });

  it('a stored failure reason passes through the narrowing', async () => {
    mockFindForOwner.mockResolvedValue({
      id: PARSE_ID,
      result: null,
      failureReason: 'too_large',
      completedAt: new Date(),
      createdAt: new Date(),
    });
    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result).toEqual({ status: 'failed', failureReason: 'too_large' });
  });

  it('an unrecognised stored failure reason falls back to unknown', async () => {
    mockFindForOwner.mockResolvedValue({
      id: PARSE_ID,
      result: null,
      failureReason: 'some_future_reason',
      completedAt: new Date(),
      createdAt: new Date(),
    });
    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result).toEqual({ status: 'failed', failureReason: 'unknown' });
  });

  /** A succeeded row whose stored markdown is `descriptionMarkdown`. */
  function succeededRow(descriptionMarkdown: string): Record<string, unknown> {
    return {
      id: PARSE_ID,
      result: {
        title: 'A title',
        descriptionMarkdown,
        tagIds: ['live-tag', 'stale-tag'],
        productIds: ['live-product'],
        unmatchedTagLabels: ['sandbox refresh'],
        unmatchedProductLabels: [],
      },
      failureReason: null,
      completedAt: new Date(),
      createdAt: new Date(),
    };
  }

  const liveTaxonomies = {
    tags: { groups: [{ id: 'g1', name: 'G', items: [{ id: 'live-tag', name: 'Live Tag' }] }] },
    products: {
      groups: [{ id: 'g2', name: 'G2', items: [{ id: 'live-product', name: 'Live Product' }] }],
    },
    loadFailed: false,
  };

  /**
   * ⚠⚠ FIX ROUND F9 — THIS ASSERTION IS THE SANITISER PIN, AND IT ONLY COUNTS BECAUSE OF THE
   * LINK. The previous corpus was `**bold** text`, whose converted HTML passes through
   * `sanitizeProjectHtml` COMPLETELY UNCHANGED — so the test stayed green with the sanitise call
   * deleted entirely, which is the one thing it existed to catch.
   *
   * `sanitizeProjectHtml` FORCES `rel="noopener noreferrer nofollow"` and `target="_blank"` onto
   * every anchor (`lib/sanitize/project-html.ts`'s `transformTags`). The converter emits a bare
   * `<a href="…">`. Those two attributes therefore appear IF AND ONLY IF the sanitiser ran.
   *
   * PROVED BY MUTATION: dropping the `sanitizeProjectHtml(...)` wrapper in the action turns this
   * red; restoring it turns it green.
   */
  it('succeeded: converts markdown THEN sanitises (D4 ordering, proved by the forced rel/target)', async () => {
    mockFindForOwner.mockResolvedValue(
      succeededRow('See [the brief](https://example.com) and **bold** text.')
    );
    mockLoadTaxonomies.mockResolvedValue(liveTaxonomies);

    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('expected succeeded');
    expect(result.draft.descriptionHtml).toBe(
      '<p>See <a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">' +
        'the brief</a> and <strong>bold</strong> text.</p>'
    );
    expect(result.draft.tagIds).toEqual(['live-tag']);
    expect(result.draft.productIds).toEqual(['live-product']);
    expect(result.draft.unmatchedTagLabels).toEqual(['sandbox refresh']);
  });

  it('succeeded: raw HTML stored in the markdown reaches the client as inert ESCAPED TEXT', async () => {
    // The converter escapes first (so the sanitiser never even sees markup here), and the
    // sanitiser leaves the already-escaped entities alone. Pinned as a full literal so a change
    // to either half of that pipeline has to be looked at, not inferred.
    mockFindForOwner.mockResolvedValue(
      succeededRow('<a href="https://x.test" onclick="steal()">click</a>')
    );
    mockLoadTaxonomies.mockResolvedValue(liveTaxonomies);

    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    if (result.status !== 'succeeded') throw new Error('expected succeeded');
    expect(result.draft.descriptionHtml).toBe(
      '<p>&lt;a href="https://x.test" onclick="steal()"&gt;click&lt;/a&gt;</p>'
    );
  });

  // ── F17 — "failed to load" is not "genuinely empty" ────────────────────────────────────────
  it('⚠ a FAILED taxonomy load fails the poll rather than silently dropping every tag', async () => {
    mockFindForOwner.mockResolvedValue(succeededRow('A description.'));
    mockLoadTaxonomies.mockResolvedValue({
      tags: { groups: [] },
      products: { groups: [] },
      loadFailed: true,
    });

    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result).toEqual({ status: 'failed', failureReason: 'unknown' });
  });

  it('a GENUINELY EMPTY taxonomy still succeeds — it just drops ids nothing vouches for', async () => {
    mockFindForOwner.mockResolvedValue(succeededRow('A description.'));
    mockLoadTaxonomies.mockResolvedValue({
      tags: { groups: [] },
      products: { groups: [] },
      loadFailed: false,
    });

    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('expected succeeded');
    expect(result.draft.tagIds).toEqual([]);
    expect(result.draft.productIds).toEqual([]);
  });

  /**
   * BAL-254 W7 — `MAX_BRIEF_MARKDOWN_LENGTH` (8000) claimed "→ ≤20000 HTML", which the conversion
   * does not guarantee: escaping alone expands up to 5× (`&` → `&amp;`). Unreachable in practice,
   * but the failure mode is silent and terminal — the brief generates cleanly, prefills review,
   * and `submitProjectRequestAction` then rejects it on the `description` max with nothing on
   * screen explaining why. Refusing here gives the recoverable failure banner instead.
   */
  it('⚠ a brief whose CONVERTED HTML exceeds the submit cap is refused, not delivered unsubmittable', async () => {
    // 7000 bare ampersands: inside `MAX_BRIEF_MARKDOWN_LENGTH`, but each becomes `&amp;`
    // (5 chars) plus the `<p>…</p>` wrapper — comfortably past the 20000-character cap.
    mockFindForOwner.mockResolvedValue(succeededRow('&'.repeat(7000)));
    mockLoadTaxonomies.mockResolvedValue(liveTaxonomies);

    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });

    expect(result).toEqual({ status: 'failed', failureReason: 'invalid_output' });
  });

  it('a brief whose converted HTML fits the cap is delivered normally', async () => {
    mockFindForOwner.mockResolvedValue(succeededRow('&'.repeat(3000)));
    mockLoadTaxonomies.mockResolvedValue(liveTaxonomies);

    const result = await getProjectBriefParseAction({ parseId: PARSE_ID });

    expect(result.status).toBe('succeeded');
  });

  it('an invalid parseId shape resolves to not_found (never throws)', async () => {
    const result = await getProjectBriefParseAction({ parseId: 'not-a-uuid' });
    expect(result).toEqual({ status: 'failed', failureReason: 'not_found' });
    expect(mockFindForOwner).not.toHaveBeenCalled();
  });
});
