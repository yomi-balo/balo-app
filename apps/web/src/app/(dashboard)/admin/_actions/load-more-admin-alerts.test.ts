import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { mockListOpenPage } = vi.hoisted(() => ({ mockListOpenPage: vi.fn() }));
vi.mock('@balo/db', () => ({
  adminAlertsRepository: { listOpenPage: (...a: unknown[]) => mockListOpenPage(...a) },
}));

import { loadMoreAdminAlerts } from './load-more-admin-alerts';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const PERMISSION_DENIED = 'You do not have permission to do this.';

function alertRow(id: string) {
  return {
    id,
    kind: 'expert.application_pending',
    entityType: 'expert',
    entityId: 'e-1',
    detail: { title: 't', entityLabel: 'Priya Nair', evidence: 'ev', facts: [] },
    firstSeenAt: new Date('2026-09-05T12:00:00.000Z'),
    lastSeenAt: new Date('2026-09-05T12:00:00.000Z'),
    occurrences: 1,
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
    createdAt: new Date('2026-09-05T12:00:00.000Z'),
    updatedAt: new Date('2026-09-05T12:00:00.000Z'),
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockListOpenPage.mockResolvedValue({ alerts: [alertRow('a-2')], hasMore: false });
});

describe('loadMoreAdminAlerts', () => {
  it('denies an unauthenticated caller before touching the repo', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await loadMoreAdminAlerts({
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockListOpenPage).not.toHaveBeenCalled();
  });

  it('denies a viewer without VIEW_PLATFORM_ADMIN', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await loadMoreAdminAlerts({
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockListOpenPage).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor before hitting the repo', async () => {
    const result = await loadMoreAdminAlerts({
      afterFirstSeenAtIso: 'not-a-date',
      afterId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
    expect(mockListOpenPage).not.toHaveBeenCalled();
  });

  // BAL-548 fix round (B-F8) — `kinds` is bounded and membership-checked at the schema.
  it('rejects an unknown kind in the kinds array before hitting the repo', async () => {
    const result = await loadMoreAdminAlerts({
      kinds: ['not.a.real.kind'],
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
    expect(mockListOpenPage).not.toHaveBeenCalled();
  });

  it('rejects an oversized kinds array before hitting the repo', async () => {
    const result = await loadMoreAdminAlerts({
      kinds: Array.from({ length: 1000 }, () => 'expert.application_pending'),
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
    expect(mockListOpenPage).not.toHaveBeenCalled();
  });

  it('accepts a storm-derived kind (base.storm) in the kinds array', async () => {
    const result = await loadMoreAdminAlerts({
      kinds: ['expert.application_pending.storm'],
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(true);
    expect(mockListOpenPage).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['expert.application_pending.storm'] })
    );
  });

  it('paginates with the given kinds and cursor, returning rows + hasMore + nextCursor', async () => {
    mockListOpenPage.mockResolvedValue({ alerts: [alertRow('a-2')], hasMore: true });
    const result = await loadMoreAdminAlerts({
      kinds: ['expert.application_pending'],
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(mockListOpenPage).toHaveBeenCalledWith({
      kinds: ['expert.application_pending'],
      after: {
        firstSeenAt: new Date('2026-09-05T12:00:00.000Z'),
        id: 'b0000000-0000-4000-8000-000000000001',
      },
      limit: 50,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.entityHead).toBe('Priya Nair');
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toEqual({
        firstSeenAtIso: '2026-09-05T12:00:00.000Z',
        id: 'a-2',
      });
    }
  });

  it('wires canSeeFees from MANAGE_PLATFORM_FEES — a fee-holding staff role keeps expert/margin', async () => {
    // ⚠ Every shipped staff role holds MANAGE_PLATFORM_FEES today (the D5 per-item bundle
    // split has not landed), so `admin` is the only reachable positive case here. The STRIP
    // itself (`canSeeFees === false` omitting expert/margin/markup) is exercised exhaustively
    // in `admin-queue-view.test.ts`, at the pure `buildAdminQueueRow` level, independent of
    // which role can reach it — this test only pins that this action passes `canSeeFees`
    // through rather than hardcoding it.
    mockListOpenPage.mockResolvedValue({
      alerts: [
        {
          ...alertRow('a-3'),
          kind: 'receivable.open',
          detail: {
            title: 't',
            entityLabel: 'Northwind',
            evidence: 'ev',
            facts: [],
            money: { client: 'A$500.00', expert: 'A$400.00', margin: 'A$100.00', markup: '25%' },
          },
        },
      ],
      hasMore: false,
    });
    const result = await loadMoreAdminAlerts({
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows[0]?.money?.expert).toBe('A$400.00');
      expect(result.rows[0]?.money?.client).toBe('A$500.00');
    }
  });

  it('maps a repo throw to the generic failure and logs it', async () => {
    mockListOpenPage.mockRejectedValue(new Error('DB down'));
    const result = await loadMoreAdminAlerts({
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(result).toEqual({
      success: false,
      error: 'Could not load more. Try again in a moment.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load more admin alerts',
      expect.objectContaining({ error: 'DB down', actorUserId: ADMIN.id })
    );
  });
});
