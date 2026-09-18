import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-567 — the loader's AUTHORIZATION SEAM and its batching, at the `@balo/db` boundary.
 *
 * ⚠⚠ THE LOAD-BEARING CASES ARE THE DENIALS. `casesIndexRepository` makes no authorization
 * decision of its own, so if the gate were skipped — or run after the read — the page would list
 * another party's cases and every other test here would still pass.
 */

const m = {
  listOpenCases: vi.fn(),
  listResolvedCases: vi.fn(),
  countCasesForScope: vi.fn(),
  listCaseTrailMeetings: vi.fn(),
  listCaseProductTags: vi.fn(),
  countOpenActionItemsByParty: vi.fn(),
  conversationIdsForContexts: vi.fn(),
  listThreadSummaries: vi.fn(),
  findLiveProposals: vi.fn(),
  findNamesByIds: vi.fn(),
  getMemberRole: vi.fn(),
};

vi.mock('@balo/db', () => ({
  CASES_INDEX_OPEN_PAGE_SIZE: 24,
  CASES_INDEX_RESOLVED_PAGE_SIZE: 20,
  casesIndexRepository: {
    listOpenCases: (...a: unknown[]) => m.listOpenCases(...a),
    listResolvedCases: (...a: unknown[]) => m.listResolvedCases(...a),
    countCasesForScope: (...a: unknown[]) => m.countCasesForScope(...a),
    listCaseTrailMeetings: (...a: unknown[]) => m.listCaseTrailMeetings(...a),
    listCaseProductTags: (...a: unknown[]) => m.listCaseProductTags(...a),
    countOpenActionItemsByParty: (...a: unknown[]) => m.countOpenActionItemsByParty(...a),
  },
  conversationsRepository: {
    conversationIdsForContexts: (...a: unknown[]) => m.conversationIdsForContexts(...a),
    listThreadSummaries: (...a: unknown[]) => m.listThreadSummaries(...a),
  },
  conversationContextKey: (ref: { contextType: string; contextId: string }) =>
    `${ref.contextType}:${ref.contextId}`,
  partyMembershipsRepository: {
    getMemberRole: (...a: unknown[]) => m.getMemberRole(...a),
  },
  rescheduleProposalsRepository: {
    findLivePendingByMeetingIds: (...a: unknown[]) => m.findLiveProposals(...a),
  },
  usersRepository: { findNamesByIds: (...a: unknown[]) => m.findNamesByIds(...a) },
}));

const mockResolveCompanyParticipation = vi.fn();
vi.mock('@balo/shared/authz', () => ({
  resolveCompanyParticipation: (...a: unknown[]) => mockResolveCompanyParticipation(...a),
}));

const mockGetChecklistStatus = vi.fn();
vi.mock('@/lib/actions/expert-checklist', () => ({
  getChecklistStatus: () => mockGetChecklistStatus(),
}));

import {
  loadCasesIndex,
  loadMoreOpenCasesPage,
  loadResolvedCasesPage,
  resolveCasesIndexRequest,
  type CasesIndexRequest,
} from './load-cases-index';
import { log } from '@/lib/logging';

const NOW = new Date('2026-09-16T04:30:00.000Z');
const VIEWER = 'user-viewer';
const COMPANY_REQUEST: CasesIndexRequest = {
  side: 'company',
  companyId: 'co-1',
  companyName: 'Acme Corp',
};
const EXPERT_REQUEST: CasesIndexRequest = {
  side: 'expert',
  expertProfileId: 'ep-1',
  companyName: 'Acme Corp',
};

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: VIEWER,
    email: 'dana@example.com',
    firstName: 'Dana',
    lastName: 'Whitfield',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'co-1',
    companyName: 'Acme Corp',
    companyRole: 'member',
    ...overrides,
  } as SessionUser;
}

function caseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engagementId: 'eng-1',
    title: 'CPQ discount schedule errors',
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    resolutionRequestedAt: null,
    resolutionRequestedByUserId: null,
    companyId: 'co-1',
    companyName: 'Acme Corp',
    expertProfileId: 'ep-1',
    expertUserId: 'user-expert',
    expertFirstName: 'Marcus',
    expertLastName: 'Lee',
    expertAvatarUrl: null,
    expertUsername: 'marcus',
    expertHeadline: null,
    expertType: 'agency',
    agencyId: 'ag-1',
    agencyName: 'Stratus Advisory',
    nextBookingAt: new Date(NOW.getTime() + 3_600_000),
    lastHeldAt: null,
    heldCount: 0,
    bucket: 0,
    sortRank: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCompanyParticipation.mockResolvedValue('participant');
  mockGetChecklistStatus.mockResolvedValue({ allComplete: true });
  m.listOpenCases.mockResolvedValue({ rows: [], hasMore: false });
  m.listResolvedCases.mockResolvedValue({ rows: [], hasMore: false });
  m.countCasesForScope.mockResolvedValue({ open: 0, resolved: 0 });
  m.listCaseTrailMeetings.mockResolvedValue(new Map());
  m.listCaseProductTags.mockResolvedValue(new Map());
  m.countOpenActionItemsByParty.mockResolvedValue(new Map());
  m.conversationIdsForContexts.mockResolvedValue(new Map());
  m.listThreadSummaries.mockResolvedValue([]);
  m.findLiveProposals.mockResolvedValue([]);
  m.findNamesByIds.mockResolvedValue([]);
  m.getMemberRole.mockResolvedValue('member');
});

// ── Which list, from the session ──────────────────────────────────────────────────────────────

describe('resolveCasesIndexRequest', () => {
  it('reads the COMPANY arm from the session, never from an argument', () => {
    expect(resolveCasesIndexRequest(sessionUser())).toEqual({
      side: 'company',
      companyId: 'co-1',
      companyName: 'Acme Corp',
    });
  });

  it('reads the EXPERT arm when the session is in expert mode with a profile', () => {
    expect(
      resolveCasesIndexRequest(sessionUser({ activeMode: 'expert', expertProfileId: 'ep-1' }))
    ).toEqual({ side: 'expert', expertProfileId: 'ep-1', companyName: 'Acme Corp' });
  });

  it('is NULL for an expert-mode session with no profile — the page redirects', () => {
    expect(resolveCasesIndexRequest(sessionUser({ activeMode: 'expert' }))).toBeNull();
  });

  it('treats an EMPTY-STRING profile id as no profile (the `requireExpert` check)', () => {
    expect(
      resolveCasesIndexRequest(sessionUser({ activeMode: 'expert', expertProfileId: '' }))
    ).toBeNull();
  });
});

// ── The gate ──────────────────────────────────────────────────────────────────────────────────

describe('the company arm’s participation gate', () => {
  it('resolves it EXACTLY ONCE, with the session’s own company and the viewer', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });

    expect(mockResolveCompanyParticipation).toHaveBeenCalledTimes(1);
    const [companyId, actorUserId, lookup] = mockResolveCompanyParticipation.mock.calls[0] ?? [];
    expect(companyId).toBe('co-1');
    expect(actorUserId).toBe(VIEWER);
    expect(typeof lookup).toBe('function');
  });

  it('hands the lookup BOTH ids per call — the confused-deputy guard', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    const [, , lookup] = mockResolveCompanyParticipation.mock.calls[0] ?? [];
    await (lookup as (a: string, b: string) => Promise<unknown>)('co-9', 'user-9');
    expect(m.getMemberRole).toHaveBeenCalledWith('company', 'co-9', 'user-9');
  });

  it.each(['member_without_participate', 'not_a_member'] as const)(
    'returns the LOCK state for %s, with ZERO repository reads',
    async (participation) => {
      mockResolveCompanyParticipation.mockResolvedValue(participation);

      const data = await loadCasesIndex({
        viewerUserId: VIEWER,
        request: COMPANY_REQUEST,
        now: NOW,
      });

      expect(data).toEqual({ kind: 'no_access', companyName: 'Acme Corp' });
      expect(m.listOpenCases).not.toHaveBeenCalled();
      expect(m.countCasesForScope).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'Cases index denied: viewer does not participate in the workspace company',
        expect.objectContaining({ userId: VIEWER, companyId: 'co-1', participation })
      );
    }
  );

  it('the EXPERT arm never resolves company participation at all', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: EXPERT_REQUEST, now: NOW });
    expect(mockResolveCompanyParticipation).not.toHaveBeenCalled();
  });

  it('scopes the repository read to the SESSION’s own party id', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    expect(m.listOpenCases).toHaveBeenCalledWith(
      { side: 'company', companyId: 'co-1' },
      { limit: 24 }
    );

    vi.clearAllMocks();
    m.listOpenCases.mockResolvedValue({ rows: [], hasMore: false });
    m.countCasesForScope.mockResolvedValue({ open: 1, resolved: 0 });
    await loadCasesIndex({ viewerUserId: VIEWER, request: EXPERT_REQUEST, now: NOW });
    expect(m.listOpenCases).toHaveBeenCalledWith(
      { side: 'expert', expertProfileId: 'ep-1', viewerUserId: VIEWER },
      { limit: 24 }
    );
  });
});

// ── Batching ──────────────────────────────────────────────────────────────────────────────────

describe('the batched reads', () => {
  beforeEach(() => {
    m.listOpenCases.mockResolvedValue({
      rows: [caseRow(), caseRow({ engagementId: 'eng-2', bucket: 1, nextBookingAt: null })],
      hasMore: true,
    });
    m.countCasesForScope.mockResolvedValue({ open: 26, resolved: 4 });
  });

  it('reads the trail, the tags and the action items ONCE, over EVERY id on the page', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });

    for (const read of [
      m.listCaseTrailMeetings,
      m.listCaseProductTags,
      m.countOpenActionItemsByParty,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(['eng-1', 'eng-2']);
    }
  });

  it('reads names ONCE over the union of attributed actors, and not at all without one', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    expect(m.findNamesByIds).not.toHaveBeenCalled();

    vi.clearAllMocks();
    m.listOpenCases.mockResolvedValue({
      rows: [caseRow({ resolutionRequestedByUserId: 'user-expert' })],
      hasMore: false,
    });
    m.countCasesForScope.mockResolvedValue({ open: 1, resolved: 0 });
    m.listCaseTrailMeetings.mockResolvedValue(new Map());
    m.listCaseProductTags.mockResolvedValue(new Map());
    m.countOpenActionItemsByParty.mockResolvedValue(new Map());
    m.conversationIdsForContexts.mockResolvedValue(new Map());
    m.listThreadSummaries.mockResolvedValue([]);
    m.findLiveProposals.mockResolvedValue([]);
    m.findNamesByIds.mockResolvedValue([]);

    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    expect(m.findNamesByIds).toHaveBeenCalledTimes(1);
    expect(m.findNamesByIds).toHaveBeenCalledWith(['user-expert']);
  });

  it('never reads proposals when the page has no meetings at all', async () => {
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    expect(m.findLiveProposals).not.toHaveBeenCalled();
  });

  it('reads proposals ONCE over every meeting on the page', async () => {
    m.listCaseTrailMeetings.mockResolvedValue(
      new Map([
        [
          'eng-1',
          [
            {
              meetingId: 'm-1',
              scheduledStart: NOW,
              scheduledEnd: NOW,
              startedAt: null,
              status: 'scheduled',
              outcome: null,
            },
          ],
        ],
        [
          'eng-2',
          [
            {
              meetingId: 'm-2',
              scheduledStart: NOW,
              scheduledEnd: NOW,
              startedAt: null,
              status: 'ended',
              outcome: 'completed',
            },
          ],
        ],
      ])
    );
    await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    expect(m.findLiveProposals).toHaveBeenCalledTimes(1);
    expect(m.findLiveProposals).toHaveBeenCalledWith(['m-1', 'm-2']);
  });

  it('marks a thread unread only when inbound activity is newer than the read watermark', async () => {
    m.conversationIdsForContexts.mockResolvedValue(
      new Map([
        ['engagement:eng-1', 'conv-1'],
        ['engagement:eng-2', 'conv-2'],
      ])
    );
    m.listThreadSummaries.mockResolvedValue([
      {
        conversationId: 'conv-1',
        latestInboundActivityAt: new Date('2026-09-15T00:00:00.000Z'),
        lastReadAt: null,
      },
      {
        conversationId: 'conv-2',
        latestInboundActivityAt: new Date('2026-09-15T00:00:00.000Z'),
        lastReadAt: new Date('2026-09-15T01:00:00.000Z'),
      },
    ]);

    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.featured?.unread).toBe(true);
    expect(data.open[0]?.unread).toBe(false);
    expect(m.listThreadSummaries).toHaveBeenCalledWith({
      conversationIds: ['conv-1', 'conv-2'],
      viewerUserId: VIEWER,
    });
  });

  it('lifts the featured case out of the grid and hands back a cursor', async () => {
    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.featured?.engagementId).toBe('eng-1');
    expect(data.open.map((card) => card.engagementId)).toEqual(['eng-2']);
    expect(data.openCount).toBe(26);
    expect(data.resolvedCount).toBe(4);
    expect(data.openHasMore).toBe(true);
    expect(data.openCursor).toEqual({ bucket: 1, sortRank: 1, id: 'eng-2' });
  });

  it('promotes NOTHING when the first row has no booking', async () => {
    m.listOpenCases.mockResolvedValue({
      rows: [caseRow({ nextBookingAt: null, bucket: 1 })],
      hasMore: false,
    });
    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.featured).toBeNull();
    expect(data.open).toHaveLength(1);
    expect(data.openCursor).toBeNull();
  });
});

// ── Empty states ──────────────────────────────────────────────────────────────────────────────

describe('the empty state', () => {
  it('is `no_cases` on the client side, with no checklist read', async () => {
    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.empty).toBe('no_cases');
    expect(mockGetChecklistStatus).not.toHaveBeenCalled();
  });

  it('is `expert_setup_incomplete` for an expert whose setup is unfinished', async () => {
    mockGetChecklistStatus.mockResolvedValue({ allComplete: false });
    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: EXPERT_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.empty).toBe('expert_setup_incomplete');
  });

  it('treats a FAILED checklist read as incomplete, and says so in the log', async () => {
    mockGetChecklistStatus.mockRejectedValue(new Error('boom'));
    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: EXPERT_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.empty).toBe('expert_setup_incomplete');
    expect(log.warn).toHaveBeenCalled();
  });

  it('is null whenever the workspace has ANY case, open or resolved', async () => {
    m.countCasesForScope.mockResolvedValue({ open: 0, resolved: 3 });
    const data = await loadCasesIndex({ viewerUserId: VIEWER, request: COMPANY_REQUEST, now: NOW });
    if (data.kind !== 'ready') throw new Error('expected a ready view');
    expect(data.empty).toBeNull();
  });
});

// ── The paged reads ───────────────────────────────────────────────────────────────────────────

describe('the "show more" reads', () => {
  const CURSOR = { bucket: 0, sortRank: 1, id: 'eng-1' };

  it('re-runs the participation gate and returns NULL when it denies', async () => {
    mockResolveCompanyParticipation.mockResolvedValue('not_a_member');
    const page = await loadMoreOpenCasesPage({
      viewerUserId: VIEWER,
      request: COMPANY_REQUEST,
      after: CURSOR,
      now: NOW,
    });
    expect(page).toBeNull();
    expect(m.listOpenCases).not.toHaveBeenCalled();
  });

  it('never promotes a featured card on a later page', async () => {
    m.listOpenCases.mockResolvedValue({ rows: [caseRow()], hasMore: false });
    const page = await loadMoreOpenCasesPage({
      viewerUserId: VIEWER,
      request: COMPANY_REQUEST,
      after: CURSOR,
      now: NOW,
    });
    expect(page?.rows.map((row) => row.joinPath)).toEqual([null]);
    expect(m.listOpenCases).toHaveBeenCalledWith(
      { side: 'company', companyId: 'co-1' },
      { limit: 24, after: CURSOR }
    );
  });

  it('loads resolved rows WITHOUT the trail, tags, unread or proposal reads', async () => {
    m.listResolvedCases.mockResolvedValue({
      rows: [
        {
          engagementId: 'eng-9',
          title: 'Einstein bot handoff',
          companyId: 'co-1',
          companyName: 'Acme Corp',
          expertProfileId: 'ep-1',
          expertUserId: 'user-expert',
          expertFirstName: 'Marcus',
          expertLastName: 'Lee',
          expertAvatarUrl: null,
          expertUsername: 'marcus',
          expertHeadline: null,
          expertType: 'agency',
          agencyId: 'ag-1',
          agencyName: 'Stratus Advisory',
          closedAt: new Date('2026-08-03T00:00:00.000Z'),
          closeReason: 'resolved',
          heldCount: 2,
          closedAtEpoch: 1_754_179_200,
        },
      ],
      hasMore: true,
    });

    const page = await loadResolvedCasesPage({ viewerUserId: VIEWER, request: COMPANY_REQUEST });

    expect(page?.rows).toHaveLength(1);
    expect(page?.nextCursor).toEqual({ closedAtEpoch: 1_754_179_200, id: 'eng-9' });
    expect(m.listCaseTrailMeetings).not.toHaveBeenCalled();
    expect(m.listCaseProductTags).not.toHaveBeenCalled();
    expect(m.listThreadSummaries).not.toHaveBeenCalled();
    expect(m.findLiveProposals).not.toHaveBeenCalled();
  });

  it('hands back NO resolved cursor when there is nothing after the page', async () => {
    m.listResolvedCases.mockResolvedValue({ rows: [], hasMore: false });
    const page = await loadResolvedCasesPage({ viewerUserId: VIEWER, request: COMPANY_REQUEST });
    expect(page?.nextCursor).toBeNull();
    expect(m.listResolvedCases).toHaveBeenCalledWith(
      { side: 'company', companyId: 'co-1' },
      { limit: 20, after: undefined }
    );
  });
});
