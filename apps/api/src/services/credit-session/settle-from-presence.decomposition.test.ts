import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-474 (ADR-1040 Amendment 7 §C.6) — the three pieces `settle-from-presence.ts` was decomposed into
 * so the sessionless open settles through the SAME path. `settle-from-presence.test.ts` (untouched)
 * pins the wrapper that composes them; this file pins each piece where the wrapper's tests cannot
 * reach: a computation with NO session, the repository input the settlement hands over, and the
 * post-commit tail's ownerless-debt alarm and basis log.
 */

const {
  mockSettlementFacts,
  mockFinalizeAndSettle,
  mockFinalizeBilling,
  mockReportOwnerless,
  mockError,
  mockInfo,
} = vi.hoisted(() => ({
  mockSettlementFacts: vi.fn(),
  mockFinalizeAndSettle: vi.fn(),
  mockFinalizeBilling: vi.fn(),
  mockReportOwnerless: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: vi.fn(), error: mockError }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {},
  meetingsRepository: {},
  meetingPresenceRepository: { settlementFacts: mockSettlementFacts },
}));
vi.mock('../../config/billing-floor.js', () => ({
  resolveBillingFloorMs: () => 15 * 60_000,
  resolveBillingFloorMinutes: () => 15,
  resolveMaxBillableMinutes: () => 240,
}));
vi.mock('./end-session.js', () => ({ finalizeAndSettle: mockFinalizeAndSettle }));
vi.mock('./finalize-billing.js', () => ({ finalizeBilling: mockFinalizeBilling }));
vi.mock('./debt-owner-alarm.js', () => ({ reportOwnerlessPriorDebt: mockReportOwnerless }));

import {
  buildSettlementRepoFields,
  completePresenceSettlement,
  computeMeetingPresenceSettlement,
} from './settle-from-presence.js';

const NOW = new Date('2026-09-25T10:30:00.000Z');
const START = new Date('2026-09-25T10:00:00.000Z');
const ENDED_AT = new Date('2026-09-25T10:20:00.000Z');
const MEETING = { id: 'meeting-1', scheduledStart: START, endedAt: ENDED_AT };

/** The expert waited 20 minutes; nobody from the client side ever came. */
const NO_SHOW_CLOCKS = {
  expertPresentMs: 20 * 60_000,
  billableMs: 0,
  expertFirstJoinedAt: START,
  billableStartedAt: null,
};

const mockResolveExpertProfileId = vi.fn();

describe('computeMeetingPresenceSettlement (the pure-core half, sessionless-capable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettlementFacts.mockResolvedValue({
      clocks: NO_SHOW_CLOCKS,
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: NO_SHOW_CLOCKS.expertPresentMs,
      facts: { clientSideEverPresent: false },
    });
  });

  it('computes a client no-show from a meeting with NO session, reading the clocks at ended_at', async () => {
    const settlement = await computeMeetingPresenceSettlement({
      meeting: MEETING,
      sessionId: null,
      minutesAlreadyDrawn: 0,
      now: NOW,
      resolveExpertProfileId: mockResolveExpertProfileId,
    });

    expect(mockSettlementFacts).toHaveBeenCalledWith('meeting-1', {
      scheduledStart: MEETING.scheduledStart,
      now: ENDED_AT,
      // R6F-4a — handed straight through, still lazy: the repository calls it only when a guest row exists.
      resolveExpertProfileId: mockResolveExpertProfileId,
    });
    expect(mockResolveExpertProfileId).not.toHaveBeenCalled();
    expect(settlement.shape).toBe('no_show_client');
    // The floor, FLAT — the expert waited 20 minutes and is owed the 15-minute minimum.
    expect(settlement.billableMinutes).toBe(15);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('a legacy row with no stamped end uses `now` as the ceiling', async () => {
    await computeMeetingPresenceSettlement({
      meeting: { ...MEETING, endedAt: null },
      sessionId: null,
      minutesAlreadyDrawn: 0,
      now: NOW,
      resolveExpertProfileId: mockResolveExpertProfileId,
    });
    expect(mockSettlementFacts).toHaveBeenCalledWith('meeting-1', {
      scheduledStart: MEETING.scheduledStart,
      now: NOW,
      resolveExpertProfileId: mockResolveExpertProfileId,
    });
  });

  it('the F1 cap and the Q1 no-refund clamp still log loud, labelled with a NULL session id when there is none', async () => {
    mockSettlementFacts.mockResolvedValue({
      clocks: {
        expertPresentMs: 500 * 60_000,
        billableMs: 500 * 60_000,
        expertFirstJoinedAt: START,
        billableStartedAt: START,
      },
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: 500 * 60_000,
      facts: { clientSideEverPresent: true },
    });

    await computeMeetingPresenceSettlement({
      meeting: MEETING,
      sessionId: null,
      minutesAlreadyDrawn: 0,
      now: NOW,
      resolveExpertProfileId: mockResolveExpertProfileId,
    });

    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: null,
        meetingId: 'meeting-1',
        uncappedRuleMinutes: 500,
      }),
      expect.stringContaining('CAPPED at maxBillableMinutes')
    );
  });
});

describe('buildSettlementRepoFields', () => {
  it('hands the repository the pure core’s answer verbatim, plus the actor, the clock and the TOCTOU anchor', () => {
    const settlement = {
      shape: 'no_show_client',
      outcome: 'no_show_client',
      billableMinutes: 15,
      actualMinutes: 20,
      floorApplied: true,
      topUpFromTickSeq: 1,
      topUpToTickSeq: 15,
    } as unknown as Parameters<typeof buildSettlementRepoFields>[0];

    expect(
      buildSettlementRepoFields(settlement, {
        minutesAlreadyDrawn: 0,
        actorUserId: 'ender-1',
        now: NOW,
      })
    ).toEqual({
      billableMinutes: 15,
      actualMinutes: 20,
      billingFloorMinutes: 15,
      topUpFromTickSeq: 1,
      topUpToTickSeq: 15,
      minutesAlreadyDrawn: 0,
      shape: 'no_show_client',
      // ⚠ THE CORE'S ANSWER, threaded — never re-derived as `billableMinutes > actualMinutes`.
      floorApplied: true,
      outcome: 'no_show_client',
      actorUserId: 'ender-1',
      now: NOW,
    });
  });

  it('the system actor is NULL, never fabricated', () => {
    const fields = buildSettlementRepoFields(
      { shape: 'held', outcome: 'completed' } as unknown as Parameters<
        typeof buildSettlementRepoFields
      >[0],
      { minutesAlreadyDrawn: 3, actorUserId: null, now: NOW }
    );
    expect(fields.actorUserId).toBeNull();
    expect(fields.minutesAlreadyDrawn).toBe(3);
  });
});

describe('completePresenceSettlement (the post-commit tail)', () => {
  const SETTLEMENT = {
    shape: 'no_show_client',
    outcome: 'no_show_client',
    actualMinutes: 20,
    billableMinutes: 15,
    floorApplied: true,
  } as unknown as Parameters<typeof completePresenceSettlement>[0]['settlement'];

  function repoResult(overrides: Record<string, unknown> = {}) {
    return {
      session: {
        id: 'session-1',
        walletId: 'wallet-1',
        companyId: 'company-1',
        openedBy: 'system',
        billingFinalizedAt: null,
        settlementStatus: 'not_required',
        overdraftSettledMinor: 0,
      },
      overdraftMinor: 10_500,
      overdraftBasis: {
        overdraftMinor: 10_500,
        walletNegativeMinor: 20_500,
        ownConsumedMinor: 10_500,
        priorDebtLeftMinor: 10_000,
        ownerlessPriorDebtMinor: 10_000,
      },
      mandateActive: true,
      alreadySettled: false,
      ticksPosted: 15,
      outcomeWritten: true,
      ...overrides,
    } as unknown as Parameters<typeof completePresenceSettlement>[0]['repoResult'];
  }

  const CALL = { meetingId: 'meeting-1', sessionId: 'session-1', now: NOW } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFinalizeAndSettle.mockResolvedValue({
      settlementStatus: 'processing',
      overdraftSettledMinor: 10_500,
    });
  });

  it('⚠ logs the share basis on its OWN line and reports the ownerless-debt reading — BEFORE the tail, so a tail fault cannot swallow the alarm', async () => {
    mockFinalizeAndSettle.mockRejectedValue(new Error('charge failed'));
    const result = repoResult();

    await expect(
      completePresenceSettlement({ repoResult: result, settlement: SETTLEMENT, ...CALL })
    ).rejects.toThrow('charge failed');

    expect(mockInfo).toHaveBeenCalledWith(
      { sessionId: 'session-1', openedBy: 'system', overdraftBasis: result.overdraftBasis },
      'Presence settlement basis'
    );
    expect(mockReportOwnerless).toHaveBeenCalledWith({
      sessionId: 'session-1',
      walletId: 'wallet-1',
      companyId: 'company-1',
      basis: result.overdraftBasis,
    });
  });

  it('runs finalizeAndSettle with the committed session, its share and the presence finalization path', async () => {
    const result = repoResult();
    await expect(
      completePresenceSettlement({ repoResult: result, settlement: SETTLEMENT, ...CALL })
    ).resolves.toEqual({
      ok: true,
      settlement: SETTLEMENT,
      result: { settlementStatus: 'processing', overdraftSettledMinor: 10_500 },
    });
    expect(mockFinalizeAndSettle).toHaveBeenCalledWith(
      result.session,
      10_500,
      true,
      'presence',
      NOW
    );
  });

  it('the success record keeps its EXACT key set — the new fields ride the separate basis line', async () => {
    await completePresenceSettlement({
      repoResult: repoResult(),
      settlement: SETTLEMENT,
      ...CALL,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        meetingId: 'meeting-1',
        shape: 'no_show_client',
        outcome: 'no_show_client',
        actualMinutes: 20,
        billableMinutes: 15,
        floorApplied: true,
        ticksPosted: 15,
        overdraftMinor: 10_500,
      },
      'Presence settlement completed'
    );
  });

  it('a lost outcome race logs that settlement did not overwrite the resolved outcome', async () => {
    await completePresenceSettlement({
      repoResult: repoResult({ outcomeWritten: false }),
      settlement: SETTLEMENT,
      ...CALL,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      { meetingId: 'meeting-1', sessionId: 'session-1', outcome: 'no_show_client' },
      'Outcome already resolved — settlement did not overwrite it'
    );
  });

  describe('the TOCTOU arm (the repository row lock caught a racing settler)', () => {
    it('replays finalizeBilling for a row finalized under BAL-399 semantics — and NOTHING else (no second charge, no second receipt, no alarm)', async () => {
      const result = repoResult({
        alreadySettled: true,
        overdraftBasis: null,
        session: {
          id: 'session-1',
          billingFinalizedAt: NOW,
          finalizationPath: null,
          settlementStatus: 'processing',
          overdraftSettledMinor: 10_500,
        },
      });

      await expect(
        completePresenceSettlement({ repoResult: result, settlement: SETTLEMENT, ...CALL })
      ).resolves.toEqual({
        ok: true,
        settlement: SETTLEMENT,
        result: { settlementStatus: 'processing', overdraftSettledMinor: 10_500 },
      });

      expect(mockFinalizeBilling).toHaveBeenCalledWith(result.session, 'presence', NOW);
      expect(mockFinalizeAndSettle).not.toHaveBeenCalled();
      expect(mockReportOwnerless).not.toHaveBeenCalled();
    });

    it('a legacy row (billingFinalizedAt NULL) gets no late payout', async () => {
      await completePresenceSettlement({
        repoResult: repoResult({
          alreadySettled: true,
          overdraftBasis: null,
          session: { id: 'session-1', billingFinalizedAt: null, settlementStatus: 'settled' },
        }),
        settlement: SETTLEMENT,
        ...CALL,
      });
      expect(mockFinalizeBilling).not.toHaveBeenCalled();
    });
  });
});
