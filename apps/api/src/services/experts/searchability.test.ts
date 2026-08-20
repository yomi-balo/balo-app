import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadInputs, mockApplySearchable, mockPublish, mockTrackServer, mockLog } = vi.hoisted(
  () => ({
    mockLoadInputs: vi.fn(),
    mockApplySearchable: vi.fn(),
    mockPublish: vi.fn(),
    mockTrackServer: vi.fn(),
    mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
);

vi.mock('@balo/db', () => ({
  expertSearchabilityRepository: {
    loadInputs: mockLoadInputs,
    applySearchable: mockApplySearchable,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  EXPERT_SETUP_SERVER_EVENTS: { SEARCHABILITY_CHANGED: 'expert_searchability_changed' },
}));

vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

const {
  planSearchabilityReconciliation,
  commitSearchabilityPlan,
  emitSearchabilityChange,
  reconcileExpertSearchability,
} = await import('./searchability.js');

// ── Helpers ──────────────────────────────────────────────────────

function completeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      headline: 'Salesforce Architect',
      bio: 'Ten years building on the platform.',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
      rateCents: 313,
      calendarConnections: [{ id: 'conn-1', credentialStatus: 'ACTIVE' }],
      hasActiveAvailabilityRules: true,
      hasPayoutDetails: true,
    },
    currentSearchable: false,
    rateCents: 313,
    ...overrides,
  };
}

/**
 * CHEAP-2 (fix round 1) — the house rule is destructure + guard, never `!`. Every test that
 * needs a `SearchabilityPlan` calls this instead of `planSearchabilityReconciliation(...)!`.
 */
async function planFor(overrides: Record<string, unknown> = {}) {
  mockLoadInputs.mockResolvedValue(completeSnapshot(overrides));
  const plan = await planSearchabilityReconciliation({
    expertProfileId: 'profile-1',
    source: 'dashboard_read',
  });
  if (!plan) throw new Error('expected a plan');
  return plan;
}

describe('planSearchabilityReconciliation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null and logs a warning when the profile is gone', async () => {
    mockLoadInputs.mockResolvedValue(undefined);
    const plan = await planSearchabilityReconciliation({
      expertProfileId: 'profile-1',
      source: 'dashboard_read',
    });
    expect(plan).toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith(
      { expertProfileId: 'profile-1', source: 'dashboard_read' },
      'searchability_reconcile_profile_missing'
    );
  });

  it('derives targetSearchable from allComplete and needsWrite from the delta', async () => {
    mockLoadInputs.mockResolvedValue(completeSnapshot({ currentSearchable: false }));
    const plan = await planSearchabilityReconciliation({
      expertProfileId: 'profile-1',
      source: 'dashboard_read',
    });
    expect(plan?.targetSearchable).toBe(true);
    expect(plan?.needsWrite).toBe(true);
    expect(plan?.derivation.failingItems).toEqual([]);
  });

  it('needsWrite is false when the plan already matches the committed row', async () => {
    mockLoadInputs.mockResolvedValue(completeSnapshot({ currentSearchable: true }));
    const plan = await planSearchabilityReconciliation({
      expertProfileId: 'profile-1',
      source: 'dashboard_read',
    });
    expect(plan?.targetSearchable).toBe(true);
    expect(plan?.needsWrite).toBe(false);
  });

  it('D4 / §B.3: applies a credentialStatusOverride for the not-yet-committed connection', async () => {
    mockLoadInputs.mockResolvedValue(
      completeSnapshot({
        inputs: {
          ...completeSnapshot().inputs,
          calendarConnections: [{ id: 'conn-1', credentialStatus: 'ACTIVE' }],
        },
      })
    );
    const plan = await planSearchabilityReconciliation({
      expertProfileId: 'profile-1',
      source: 'calendar_credential_break',
      credentialStatusOverride: { connectionId: 'conn-1', credentialStatus: 'EXPIRED' },
    });
    expect(plan?.derivation.items.calendar).toBe(false);
    expect(plan?.targetSearchable).toBe(false);
  });

  it('D4: a second ACTIVE connection keeps calendar true despite the override on the first', async () => {
    mockLoadInputs.mockResolvedValue(
      completeSnapshot({
        inputs: {
          ...completeSnapshot().inputs,
          calendarConnections: [
            { id: 'conn-1', credentialStatus: 'ACTIVE' },
            { id: 'conn-2', credentialStatus: 'ACTIVE' },
          ],
        },
      })
    );
    const plan = await planSearchabilityReconciliation({
      expertProfileId: 'profile-1',
      source: 'calendar_credential_break',
      credentialStatusOverride: { connectionId: 'conn-1', credentialStatus: 'EXPIRED' },
    });
    expect(plan?.derivation.items.calendar).toBe(true);
    expect(plan?.targetSearchable).toBe(true);
  });
});

describe('commitSearchabilityPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the plan target, source, actor and failingItems to the repository', async () => {
    const plan = await planFor({ currentSearchable: false });
    mockApplySearchable.mockResolvedValue({
      changed: true,
      auditEventId: 'audit-1',
      previousSearchable: false,
    });

    await commitSearchabilityPlan(plan, { source: 'dashboard_read', actorUserId: 'user-1' });

    expect(mockApplySearchable).toHaveBeenCalledWith(
      {
        expertProfileId: 'profile-1',
        searchable: true,
        actorUserId: 'user-1',
        source: 'dashboard_read',
        failingItems: [],
      },
      undefined
    );
  });

  it('forwards the executor when passed, for transaction composition', async () => {
    const plan = await planFor({ currentSearchable: false });
    mockApplySearchable.mockResolvedValue({ changed: false });
    const tx = {} as never;

    await commitSearchabilityPlan(
      plan,
      { source: 'calendar_credential_break', actorUserId: null },
      tx
    );

    expect(mockApplySearchable).toHaveBeenCalledWith(expect.anything(), tx);
  });
});

describe('emitSearchabilityChange', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op — no log, no track, no publish — when result.changed is false', async () => {
    const plan = await planFor({ currentSearchable: true });
    await emitSearchabilityChange({
      expertProfileId: 'profile-1',
      plan,
      result: { changed: false },
      source: 'dashboard_read',
      publishNotification: true,
    });
    expect(mockLog.info).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs and tracks on a real change, even when publishNotification is false', async () => {
    const plan = await planFor({ currentSearchable: false });
    await emitSearchabilityChange({
      expertProfileId: 'profile-1',
      plan,
      result: { changed: true, auditEventId: 'audit-1', previousSearchable: false },
      source: 'calendar_credential_break',
      publishNotification: false,
    });
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: 'profile-1', searchable: true }),
      'expert_searchability_changed'
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'expert_searchability_changed',
      expect.objectContaining({
        expert_id: 'profile-1',
        searchable: true,
        trigger: 'checklist_complete',
      })
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes expert.searchability_restored on a true transition, correlated to the audit row', async () => {
    const plan = await planFor({ currentSearchable: false });
    await emitSearchabilityChange({
      expertProfileId: 'profile-1',
      plan,
      result: { changed: true, auditEventId: 'audit-1', previousSearchable: false },
      source: 'calendar_credential_repair',
      publishNotification: true,
    });
    expect(mockPublish).toHaveBeenCalledWith('expert.searchability_restored', {
      correlationId: 'audit-1',
      expertProfileId: 'profile-1',
    });
  });

  it('publishes expert.searchability_lost with failingItems on a false transition', async () => {
    const plan = await planFor({
      currentSearchable: true,
      inputs: { ...completeSnapshot().inputs, hasPayoutDetails: false },
    });
    await emitSearchabilityChange({
      expertProfileId: 'profile-1',
      plan,
      result: { changed: true, auditEventId: 'audit-2', previousSearchable: true },
      source: 'calendar_disconnected',
      publishNotification: true,
    });
    expect(mockPublish).toHaveBeenCalledWith('expert.searchability_lost', {
      correlationId: 'audit-2',
      expertProfileId: 'profile-1',
      failingItems: ['payouts'],
    });
  });

  it('swallows and logs a publish failure rather than throwing', async () => {
    const plan = await planFor({ currentSearchable: false });
    mockPublish.mockRejectedValue(new Error('queue unavailable'));
    await expect(
      emitSearchabilityChange({
        expertProfileId: 'profile-1',
        plan,
        result: { changed: true, auditEventId: 'audit-1', previousSearchable: false },
        source: 'calendar_connected',
        publishNotification: true,
      })
    ).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('reconcileExpertSearchability', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns {changed:false} without a repository write when the profile is missing', async () => {
    mockLoadInputs.mockResolvedValue(undefined);
    const result = await reconcileExpertSearchability({
      expertProfileId: 'profile-1',
      source: 'dashboard_read',
      actorUserId: 'user-1',
      publishNotification: true,
    });
    expect(result).toEqual({ changed: false });
    expect(mockApplySearchable).not.toHaveBeenCalled();
  });

  it('§G.3: skips the repository round trip (advisory fast path) when needsWrite is false', async () => {
    mockLoadInputs.mockResolvedValue(completeSnapshot({ currentSearchable: true }));
    const result = await reconcileExpertSearchability({
      expertProfileId: 'profile-1',
      source: 'dashboard_read',
      actorUserId: 'user-1',
      publishNotification: true,
    });
    expect(result).toEqual({ changed: false });
    expect(mockApplySearchable).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('commits and emits on a genuine transition', async () => {
    mockLoadInputs.mockResolvedValue(completeSnapshot({ currentSearchable: false }));
    mockApplySearchable.mockResolvedValue({
      changed: true,
      auditEventId: 'audit-1',
      previousSearchable: false,
    });
    const result = await reconcileExpertSearchability({
      expertProfileId: 'profile-1',
      source: 'calendar_connected',
      actorUserId: null,
      publishNotification: true,
    });
    expect(result).toEqual({ changed: true, auditEventId: 'audit-1', previousSearchable: false });
    expect(mockPublish).toHaveBeenCalledWith('expert.searchability_restored', {
      correlationId: 'audit-1',
      expertProfileId: 'profile-1',
    });
  });
});
