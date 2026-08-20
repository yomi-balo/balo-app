import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockApplySearchable, mockPublish, mockTrackServerAndFlush, mockLog } = vi.hoisted(() => ({
  mockApplySearchable: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServerAndFlush: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  expertSearchabilityRepository: { applySearchable: mockApplySearchable },
}));

vi.mock('@/lib/logging', () => ({
  log: mockLog,
}));

vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: mockTrackServerAndFlush,
  EXPERT_SETUP_SERVER_EVENTS: { SEARCHABILITY_CHANGED: 'expert_searchability_changed' },
}));

vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: mockPublish,
}));

const { reconcileFromRead } = await import('./searchability');

function completeDerivation(overrides: Record<string, unknown> = {}) {
  return {
    items: {
      profile: true,
      phone: true,
      rate: true,
      calendar: true,
      availability: true,
      payouts: true,
    },
    completedCount: 6,
    allComplete: true,
    failingItems: [],
    ...overrides,
  };
}

describe('reconcileFromRead (BAL-414, D3.2 web read-path)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── CHEAP-4 — the advisory fast path ────────────────────────────

  it('CHEAP-4: skips the repository round trip entirely when currentSearchable already matches allComplete', async () => {
    const result = await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      derivation: completeDerivation(),
      currentSearchable: true,
    });

    expect(result).toEqual({ changed: false });
    expect(mockApplySearchable).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('CHEAP-4: still calls the repository (the CAS is the correctness guarantee) when currentSearchable differs from allComplete', async () => {
    mockApplySearchable.mockResolvedValue({ changed: false });

    await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      derivation: completeDerivation(),
      currentSearchable: false,
    });

    expect(mockApplySearchable).toHaveBeenCalledTimes(1);
  });

  it('is a no-op — no log, no track, no publish — when the write does not change the row', async () => {
    mockApplySearchable.mockResolvedValue({ changed: false });

    const result = await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      derivation: completeDerivation(),
      currentSearchable: false,
    });

    expect(result).toEqual({ changed: false });
    expect(mockLog.info).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('passes source dashboard_read and the session actorUserId to the repository', async () => {
    mockApplySearchable.mockResolvedValue({ changed: false });

    await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      derivation: completeDerivation({ failingItems: [] }),
      currentSearchable: false,
    });

    expect(mockApplySearchable).toHaveBeenCalledWith({
      expertProfileId: 'profile-1',
      searchable: true,
      actorUserId: 'user-1',
      source: 'dashboard_read',
      failingItems: [],
      actorImpersonating: undefined,
    });
  });

  // ── S2 — impersonation audit metadata ───────────────────────────

  it('S2: forwards actorImpersonating to the repository when the viewing session is impersonated', async () => {
    mockApplySearchable.mockResolvedValue({ changed: false });

    await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      derivation: completeDerivation(),
      currentSearchable: false,
      actorImpersonating: true,
    });

    expect(mockApplySearchable).toHaveBeenCalledWith(
      expect.objectContaining({ actorImpersonating: true })
    );
  });

  it('on a true transition: logs, tracks, and publishes expert.searchability_restored', async () => {
    mockApplySearchable.mockResolvedValue({
      changed: true,
      auditEventId: 'audit-1',
      previousSearchable: false,
    });

    const result = await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      derivation: completeDerivation(),
      currentSearchable: false,
    });

    expect(result.changed).toBe(true);
    expect(mockLog.info).toHaveBeenCalledWith(
      'Expert searchability changed',
      expect.objectContaining({ expertProfileId: 'profile-1', searchable: true })
    );
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'expert_searchability_changed',
      expect.objectContaining({
        expert_id: 'profile-1',
        searchable: true,
        trigger: 'checklist_complete',
      })
    );
    expect(mockPublish).toHaveBeenCalledWith('expert.searchability_restored', {
      correlationId: 'audit-1',
      expertProfileId: 'profile-1',
    });
  });

  it('on a false transition: publishes expert.searchability_lost with failingItems', async () => {
    mockApplySearchable.mockResolvedValue({
      changed: true,
      auditEventId: 'audit-2',
      previousSearchable: true,
    });

    await reconcileFromRead({
      expertProfileId: 'profile-1',
      actorUserId: 'user-1',
      currentSearchable: true,
      derivation: completeDerivation({
        allComplete: false,
        completedCount: 5,
        failingItems: ['payouts'],
        items: { ...completeDerivation().items, payouts: false },
      }),
    });

    expect(mockPublish).toHaveBeenCalledWith('expert.searchability_lost', {
      correlationId: 'audit-2',
      expertProfileId: 'profile-1',
      failingItems: ['payouts'],
    });
  });

  it('swallows and logs a publish failure rather than throwing', async () => {
    mockApplySearchable.mockResolvedValue({
      changed: true,
      auditEventId: 'audit-1',
      previousSearchable: false,
    });
    mockPublish.mockRejectedValue(new Error('network error'));

    await expect(
      reconcileFromRead({
        expertProfileId: 'profile-1',
        actorUserId: 'user-1',
        derivation: completeDerivation(),
        currentSearchable: false,
      })
    ).resolves.toEqual({ changed: true, auditEventId: 'audit-1', previousSearchable: false });

    expect(mockLog.error).toHaveBeenCalled();
  });
});
