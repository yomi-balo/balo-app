import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const GEN_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

const mockResolveAuthor = vi.fn();
vi.mock('./proposal-author-access', () => ({
  resolveProposalAuthorAccess: (...a: unknown[]) => mockResolveAuthor(...a),
}));

const mockPostApi = vi.fn();
vi.mock('@/lib/api/balo-api-client', () => ({
  postBaloApiJson: (...a: unknown[]) => mockPostApi(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  PROJECT_SERVER_EVENTS: { PROPOSAL_DRAFT_GENERATED: 'project_proposal_draft_generated' },
}));

const {
  mockFindCurrent,
  mockFindLive,
  mockCountSince,
  mockCreateOrGet,
  mockMarkFailed,
  mockFindForRequester,
} = vi.hoisted(() => ({
  mockFindCurrent: vi.fn(),
  mockFindLive: vi.fn(),
  mockCountSince: vi.fn(),
  mockCreateOrGet: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockFindForRequester: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  proposalsRepository: { findCurrentByRelationship: (...a: unknown[]) => mockFindCurrent(...a) },
  proposalDraftGenerationsRepository: {
    findLiveByRelationship: (...a: unknown[]) => mockFindLive(...a),
    countCreatedSince: (...a: unknown[]) => mockCountSince(...a),
    createOrGetForRelationship: (...a: unknown[]) => mockCreateOrGet(...a),
    markFailed: (...a: unknown[]) => mockMarkFailed(...a),
    findForRequester: (...a: unknown[]) => mockFindForRequester(...a),
  },
}));

import type { SessionUser } from '@/lib/auth/session';
import { MAX_PROPOSAL_DRAFTS_PER_HOUR } from '@balo/shared/project-requests';
import { log } from '@/lib/logging';
import { runGetProposalDraft, runStartProposalDraft } from './proposal-draft-generation';

const USER = { id: 'user-expert' } as SessionUser;
const START_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID };
const POLL_INPUT = { ...START_INPUT, generationId: GEN_ID };

function freshRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GEN_ID,
    relationshipId: REL_ID,
    status: 'pending',
    output: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('runStartProposalDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthor.mockResolvedValue({
      ok: true,
      relationship: { status: 'proposal_requested' },
    });
    mockFindCurrent.mockResolvedValue(undefined);
    mockFindLive.mockResolvedValue(undefined);
    mockCountSince.mockResolvedValue(0);
    mockCreateOrGet.mockResolvedValue({ row: freshRow(), created: true });
    mockPostApi.mockResolvedValue({ ok: true, data: { enqueued: true } });
    mockMarkFailed.mockResolvedValue(freshRow({ status: 'failed' }));
  });

  it('skips invalid input without touching anything', async () => {
    expect(await runStartProposalDraft(USER, { requestId: 'x', relationshipId: 'y' })).toEqual({
      status: 'skipped',
    });
    expect(mockResolveAuthor).not.toHaveBeenCalled();
  });

  it('skips when the author gate refuses', async () => {
    mockResolveAuthor.mockResolvedValue({ ok: false, error: 'Only the expert' });
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'skipped' });
    expect(mockCreateOrGet).not.toHaveBeenCalled();
    expect(mockPostApi).not.toHaveBeenCalled();
  });

  it('skips when the relationship is not awaiting a proposal', async () => {
    mockResolveAuthor.mockResolvedValue({
      ok: true,
      relationship: { status: 'proposal_submitted' },
    });
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'skipped' });
    expect(mockCreateOrGet).not.toHaveBeenCalled();
  });

  it('skips when a proposal already exists', async () => {
    mockFindCurrent.mockResolvedValue({ id: 'p1' });
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'skipped' });
    expect(mockCreateOrGet).not.toHaveBeenCalled();
    expect(mockPostApi).not.toHaveBeenCalled();
  });

  it('returns the existing row view and makes no api call', async () => {
    mockFindLive.mockResolvedValue(freshRow());
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({
      status: 'pending',
      generationId: GEN_ID,
    });
    expect(mockCountSince).not.toHaveBeenCalled();
    expect(mockCreateOrGet).not.toHaveBeenCalled();
    expect(mockPostApi).not.toHaveBeenCalled();
  });

  it('skips and writes no row at the hourly cap', async () => {
    mockCountSince.mockResolvedValue(MAX_PROPOSAL_DRAFTS_PER_HOUR);
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'skipped' });
    expect(mockCreateOrGet).not.toHaveBeenCalled();
    expect(mockPostApi).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('rate-capped'),
      expect.objectContaining({ recentCount: MAX_PROPOSAL_DRAFTS_PER_HOUR })
    );
  });

  it('counts only the last hour for the requesting user', async () => {
    await runStartProposalDraft(USER, START_INPUT);
    const [arg] = mockCountSince.mock.calls[0] as [{ requestedByUserId: string; since: Date }];
    expect(arg.requestedByUserId).toBe('user-expert');
    expect(Date.now() - arg.since.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 50);
  });

  it('is still allowed just below the cap', async () => {
    mockCountSince.mockResolvedValue(MAX_PROPOSAL_DRAFTS_PER_HOUR - 1);
    expect((await runStartProposalDraft(USER, START_INPUT)).status).toBe('pending');
  });

  it('returns the raced row view without a second enqueue when the create lost', async () => {
    mockCreateOrGet.mockResolvedValue({ row: freshRow(), created: false });
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({
      status: 'pending',
      generationId: GEN_ID,
    });
    expect(mockPostApi).not.toHaveBeenCalled();
  });

  it('creates the row, enqueues it, and answers pending', async () => {
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({
      status: 'pending',
      generationId: GEN_ID,
    });
    expect(mockCreateOrGet).toHaveBeenCalledWith({
      relationshipId: REL_ID,
      requestedByUserId: 'user-expert',
    });
    expect(mockPostApi).toHaveBeenCalledWith(
      '/proposal-drafts/generate',
      { generationId: GEN_ID },
      expect.any(Function),
      'proposal draft generation'
    );
    expect(log.info).toHaveBeenCalledWith(
      'Proposal draft generation started',
      expect.objectContaining({ relationshipId: REL_ID, generationId: GEN_ID })
    );
  });

  it('only accepts an api body of { enqueued: true }', async () => {
    await runStartProposalDraft(USER, START_INPUT);
    const parse = mockPostApi.mock.calls[0]?.[2] as (b: Record<string, unknown>) => unknown;
    expect(parse({ enqueued: true })).toEqual({ enqueued: true });
    expect(parse({ enqueued: false })).toBeNull();
    expect(parse({})).toBeNull();
  });

  it('marks enqueue_failed, tracks failed, logs, and answers failed when the enqueue fails', async () => {
    mockPostApi.mockResolvedValue({ ok: false, status: 503, code: 'enqueue_failed' });
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'failed' });
    expect(mockMarkFailed).toHaveBeenCalledWith({
      generationId: GEN_ID,
      failureReason: 'enqueue_failed',
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'project_proposal_draft_generated',
      expect.objectContaining({
        relationship_id: REL_ID,
        status: 'failed',
        milestone_count: 0,
        distinct_id: 'user-expert',
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      'Proposal draft generation enqueue failed',
      expect.objectContaining({ generationId: GEN_ID, status: 503, code: 'enqueue_failed' })
    );
  });

  it('reports latency from the failed row, both timestamps from the database clock', async () => {
    const createdAt = new Date('2026-01-01T12:00:00.000Z');
    mockCreateOrGet.mockResolvedValue({ row: freshRow({ createdAt }), created: true });
    mockPostApi.mockResolvedValue({ ok: false, status: 503, code: 'enqueue_failed' });
    mockMarkFailed.mockResolvedValue(
      freshRow({
        status: 'failed',
        createdAt,
        completedAt: new Date('2026-01-01T12:00:02.500Z'),
      })
    );
    await runStartProposalDraft(USER, START_INPUT);
    expect(mockTrack).toHaveBeenCalledWith(
      'project_proposal_draft_generated',
      expect.objectContaining({ latency_ms: 2500 })
    );
  });

  it('skips an impersonated session with no gate, no row and no api call', async () => {
    const impersonated = { id: 'admin-as-expert', isImpersonating: true } as SessionUser;
    expect(await runStartProposalDraft(impersonated, START_INPUT)).toEqual({ status: 'skipped' });
    expect(mockResolveAuthor).not.toHaveBeenCalled();
    expect(mockCreateOrGet).not.toHaveBeenCalled();
    expect(mockPostApi).not.toHaveBeenCalled();
  });

  it('does not track when the enqueue failure lost the compare-and-set to the worker', async () => {
    mockPostApi.mockResolvedValue({ ok: false, status: 503, code: 'enqueue_failed' });
    mockMarkFailed.mockResolvedValue(undefined);
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'failed' });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('logs and answers failed instead of throwing on an unexpected error', async () => {
    mockCreateOrGet.mockRejectedValue(new Error('db down'));
    expect(await runStartProposalDraft(USER, START_INPUT)).toEqual({ status: 'failed' });
    expect(log.error).toHaveBeenCalledWith(
      'Proposal draft generation start failed',
      expect.objectContaining({ relationshipId: REL_ID, error: 'db down' })
    );
  });
});

describe('runGetProposalDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthor.mockResolvedValue({ ok: true });
    mockFindForRequester.mockResolvedValue(freshRow());
  });

  it('answers failed for invalid input', async () => {
    expect(await runGetProposalDraft(USER, { ...POLL_INPUT, generationId: 'nope' })).toEqual({
      status: 'failed',
    });
    expect(mockResolveAuthor).not.toHaveBeenCalled();
  });

  it('answers failed when the gate refuses, without reading the row', async () => {
    mockResolveAuthor.mockResolvedValue({ ok: false, error: 'No access.' });
    expect(await runGetProposalDraft(USER, POLL_INPUT)).toEqual({ status: 'failed' });
    expect(mockFindForRequester).not.toHaveBeenCalled();
  });

  it('scopes the read by generation, relationship and requesting user', async () => {
    await runGetProposalDraft(USER, POLL_INPUT);
    expect(mockFindForRequester).toHaveBeenCalledWith({
      generationId: GEN_ID,
      relationshipId: REL_ID,
      requestedByUserId: 'user-expert',
    });
  });

  it('answers failed for a missing or foreign generation, the same as each other', async () => {
    mockFindForRequester.mockResolvedValue(undefined);
    expect(await runGetProposalDraft(USER, POLL_INPUT)).toEqual({ status: 'failed' });
  });

  it('answers pending for a running generation', async () => {
    expect(await runGetProposalDraft(USER, POLL_INPUT)).toEqual({
      status: 'pending',
      generationId: GEN_ID,
    });
  });

  it('answers failed for a pending generation past the deadline', async () => {
    mockFindForRequester.mockResolvedValue(freshRow({ createdAt: new Date(Date.now() - 120_000) }));
    expect(await runGetProposalDraft(USER, POLL_INPUT)).toEqual({ status: 'failed' });
  });

  it('answers with the sanitised patch for a succeeded generation', async () => {
    mockFindForRequester.mockResolvedValue(
      freshRow({
        status: 'succeeded',
        output: {
          overviewHtml: '<p>Plan</p><script>x</script>',
          milestones: [
            { title: 'One', descriptionHtml: '<p>a</p>', acceptanceCriteria: 'ok' },
            { title: 'Two', descriptionHtml: '<p>b</p>', acceptanceCriteria: 'ok' },
          ],
        },
      })
    );
    const view = await runGetProposalDraft(USER, POLL_INPUT);
    expect(view.status).toBe('succeeded');
    if (view.status === 'succeeded') {
      expect(view.patch.overviewHtml).toBe('<p>Plan</p>');
    }
  });

  it('logs and answers failed instead of throwing on an unexpected error', async () => {
    mockFindForRequester.mockRejectedValue(new Error('db down'));
    expect(await runGetProposalDraft(USER, POLL_INPUT)).toEqual({ status: 'failed' });
    expect(log.error).toHaveBeenCalledWith(
      'Proposal draft generation poll failed',
      expect.objectContaining({ generationId: GEN_ID, error: 'db down' })
    );
  });
});
