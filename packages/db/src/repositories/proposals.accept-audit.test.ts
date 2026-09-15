import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-432 — `proposalsRepository.accept`'s ADR-1030 AUDIT EMISSION, and
 * `transitionStatus`'s runtime `→ accepted` guard, proved in isolation.
 *
 * ⚠ WHY A UNIT TEST EXISTS FOR A REPOSITORY (mirrors `meetings.test.ts`'s own header). There is
 * exactly ONE property here that a real database CANNOT distinguish, and it is the load-bearing
 * one: that the `proposal.accepted` audit row is written on `accept`'s OWN `tx` HANDLE rather
 * than the base `db` client. Against real Postgres both spellings look identical on the happy
 * path, and identical under the integration harness (where `db` *is* the per-test transaction).
 * Only an identity assertion on the executor argument — `record(…, tx)`, the SAME object the
 * updates ran on — catches `tx` being swapped for `db`.
 *
 * The COMPLEMENTARY claims — that a real row lands with a real actor FK, that the whole
 * acceptance rolls back if the audit insert fails, and the persisted metadata shape — are in
 * `proposals.integration.test.ts`, where they belong. Neither file is sufficient alone.
 */

const {
  mockTransaction,
  mockSelectFor,
  mockSet,
  mockReturning,
  mockAcquireLock,
  mockAdvanceRelationship,
  mockRecord,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockSelectFor: vi.fn(),
  mockSet: vi.fn(),
  mockReturning: vi.fn(),
  mockAcquireLock: vi.fn(),
  mockAdvanceRelationship: vi.fn(),
  mockRecord: vi.fn(),
}));

// The base client — `accept` opens its transaction through this.
vi.mock('../client', () => ({ db: { transaction: (fn: unknown) => mockTransaction(fn) } }));

// THE MOCK BOUNDARY (meetings.test.ts precedent). `recordProposalAccepted` runs FOR REAL so its
// metadata fold is genuinely exercised — this is also what gives the new file its SonarCloud
// new-code coverage.
vi.mock('./audit-events', () => ({ auditEventsRepository: { record: mockRecord } }));

vi.mock('./_shared/request-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_shared/request-lock')>()),
  acquireRequestLockViaProposalTx: mockAcquireLock,
  acquireRequestLockViaRelationshipTx: vi.fn(),
}));
vi.mock('./request-expert-relationships', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./request-expert-relationships')>()),
  advanceRelationshipStatus: mockAdvanceRelationship,
}));
vi.mock('./proposal-milestones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./proposal-milestones')>()),
  listByProposalTx: vi.fn(async () => []),
}));
vi.mock('./proposal-payment-installments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./proposal-payment-installments')>()),
  listByProposalTx: vi.fn(async () => []),
}));
vi.mock('./proposal-coherence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./proposal-coherence')>()),
  assertProposalCoherent: vi.fn(),
}));

import { proposalsRepository, ProposalAcceptanceRequiresActorError } from './proposals';

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const REL_ID = '22222222-2222-4222-8222-222222222222';
const REQ_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';

/**
 * Deliberately asymmetric fixtures — so no assertion can pass by coincidence.
 * `ADVANCED_ROW.version = 99` is the trap that makes T1.4 real; `ADVANCED_ROW.acceptedByUserId =
 * null` is the trap that makes T1.7 (D6) real.
 */
const CURRENT_ROW = {
  id: PROPOSAL_ID,
  status: 'submitted' as const,
  version: 7,
  relationshipId: REL_ID,
  projectRequestId: REQ_ID,
  expertProfileId: EXPERT_ID,
  acceptedByUserId: null,
};
const ADVANCED_ROW = {
  ...CURRENT_ROW,
  status: 'accepted' as const,
  version: 99,
  acceptedByUserId: null,
};
const STAMPED_ROW = {
  ...CURRENT_ROW,
  status: 'accepted' as const,
  version: 7,
  acceptedByUserId: ACTOR_ID,
};

/** The order in which the transaction body's steps ran, for the ordering assertion (T1.5). */
let callOrder: string[] = [];
/** The exact `tx` object handed to the transaction body — the identity under test (T1.1). */
let capturedTx: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];

  // Both `accept`'s own FOR UPDATE select and `advanceProposalStatus`'s FOR UPDATE select read
  // the same locked row.
  mockSelectFor.mockResolvedValue([CURRENT_ROW]);

  mockAcquireLock.mockImplementation(async () => {
    callOrder.push('lock');
  });
  mockAdvanceRelationship.mockImplementation(async () => {
    callOrder.push('relationship');
    return { relationship: { id: REL_ID, projectRequestId: REQ_ID } };
  });
  mockRecord.mockImplementation(async () => {
    callOrder.push('audit');
    return { id: 'audit_1' };
  });

  // update #1 = advanceProposalStatus's status flip → ADVANCED_ROW.
  // update #2 = the new local actor stamp → STAMPED_ROW.
  mockSet.mockImplementationOnce(() => {
    callOrder.push('statusUpdate');
    return { where: () => ({ returning: mockReturning }) };
  });
  mockSet.mockImplementationOnce(() => {
    callOrder.push('stampUpdate');
    return { where: () => ({ returning: mockReturning }) };
  });
  mockReturning.mockResolvedValueOnce([ADVANCED_ROW]);
  mockReturning.mockResolvedValueOnce([STAMPED_ROW]);

  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    capturedTx = {
      select: () => ({ from: () => ({ where: () => ({ for: mockSelectFor }) }) }),
      update: () => ({
        set: (payload: unknown) => {
          mockSet(payload);
          return { where: () => ({ returning: mockReturning }) };
        },
      }),
    };
    return fn(capturedTx);
  });
});

describe('proposalsRepository.accept — the proposal.accepted audit row (BAL-432 / ADR-1030)', () => {
  it('T1.1 records the audit row on the ACCEPT TRANSACTION, never the base db client', async () => {
    // ⚠ THE LOAD-BEARING ASSERTION OF THIS FILE.
    await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    const [, exec] = mockRecord.mock.calls[0] ?? [];
    expect(exec).toBe(capturedTx);
  });

  it('T1.2 writes EXACTLY ONE proposal.accepted row, on the proposal, with the accepting actor', async () => {
    await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: ACTOR_ID,
      action: 'proposal.accepted',
      entityType: 'proposal',
      entityId: PROPOSAL_ID,
    });
  });

  it('T1.3 (D4) the metadata key set is EXACTLY the four ids/version — no money fields', async () => {
    await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    const metadata = (mockRecord.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    const keys = Object.keys(metadata);

    expect(keys).toHaveLength(4); // ⚠ NON-VACUITY ANCHOR
    expect([...keys].sort()).toEqual([
      'expertProfileId',
      'projectRequestId',
      'proposalVersion',
      'relationshipId',
    ]);
    expect(metadata).toEqual({
      relationshipId: REL_ID,
      projectRequestId: REQ_ID,
      expertProfileId: EXPERT_ID,
      proposalVersion: 7,
    });
  });

  it("T1.4 proposalVersion is the LOCKED row's version, not the post-flip re-read", async () => {
    await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    const metadata = (mockRecord.mock.calls[0]?.[0] as { metadata: { proposalVersion: number } })
      .metadata;
    expect(metadata.proposalVersion).toBe(7);
  });

  it('T1.5 orders lock → relationship → statusUpdate → stampUpdate → audit', async () => {
    await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    expect(callOrder).toEqual(['lock', 'relationship', 'statusUpdate', 'stampUpdate', 'audit']);
  });

  it('T1.6 the local stamp update payload is EXACTLY { acceptedByUserId }, no spread', async () => {
    await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    expect(mockSet.mock.calls).toHaveLength(2); // ⚠ NON-VACUITY ANCHOR
    expect(mockSet.mock.calls[1]?.[0]).toEqual({ acceptedByUserId: ACTOR_ID });
  });

  it('T1.7 (D6) returns the RE-STAMPED row, not the pre-stamp advanced row', async () => {
    const result = await proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID });

    expect(result).toBe(STAMPED_ROW);
    expect(result.acceptedByUserId).toBe(ACTOR_ID);
  });

  it('T1.8 throws when the stamp update returns no row', async () => {
    // Override JUST the second `.returning()` call (the local stamp) to come back empty —
    // the first (advanceProposalStatus's flip) still succeeds.
    mockReturning.mockReset();
    mockReturning.mockResolvedValueOnce([ADVANCED_ROW]);
    mockReturning.mockResolvedValueOnce([]);

    await expect(
      proposalsRepository.accept({ id: PROPOSAL_ID, actorUserId: ACTOR_ID })
    ).rejects.toThrow(/Failed to stamp acceptedByUserId/);
  });
});

describe('proposalsRepository.transitionStatus — the BAL-432 attributed-transition guard', () => {
  it('T2 refuses to move a proposal to accepted, WITHOUT opening a transaction', async () => {
    await expect(
      // @ts-expect-error — `to` excludes 'accepted' by construction (BAL-432); this call exists
      // to prove the RUNTIME guard survives TypeScript's erasure.
      proposalsRepository.transitionStatus({ id: PROPOSAL_ID, to: 'accepted' })
    ).rejects.toBeInstanceOf(ProposalAcceptanceRequiresActorError);

    expect(mockTransaction).not.toHaveBeenCalled(); // ⚠ the guard runs BEFORE db.transaction(
  });
});
