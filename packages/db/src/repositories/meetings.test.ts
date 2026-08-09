import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-129 — `meetingsRepository.create`'s ADR-1030 AUDIT EMISSION, proved in isolation.
 *
 * ⚠ WHY A UNIT TEST EXISTS AT ALL FOR A REPOSITORY, when every other write-path claim in this
 * package is an integration test. There is exactly ONE property here that a real database
 * CANNOT distinguish, and it is the load-bearing one: that the audit row is written on the
 * BOOKING'S `tx` HANDLE rather than the base `db` client. Against real Postgres both spellings
 * look identical on the happy path (the row is there either way) and identical under the
 * harness's per-test transaction (everything rolls back regardless). Only an identity
 * assertion on the executor argument — `record(…, tx)`, the SAME object the inserts ran on —
 * catches `tx` being swapped for `db`, which is precisely the regression that would leave an
 * audit row attesting to a booking that rolled back.
 *
 * The COMPLEMENTARY claims — that a real row lands, with a real actor FK, and that the whole
 * booking rolls back if the audit insert fails — are in `meetings.integration.test.ts`, where
 * they belong. Neither file is sufficient alone.
 */

const {
  mockTransaction,
  mockMeetingReturning,
  mockContextReturning,
  mockProjectNewMeeting,
  mockRecord,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockMeetingReturning: vi.fn(),
  mockContextReturning: vi.fn(),
  mockProjectNewMeeting: vi.fn(),
  mockRecord: vi.fn(),
}));

vi.mock('../client', () => ({
  db: { transaction: (fn: unknown) => mockTransaction(fn) },
}));

// The projection is mocked because it is `_shared/consultation-projection.ts`'s claim, proved
// by its own tests. What matters here is only that it runs BEFORE the audit write and supplies
// the `expertProfileId` the audit row carries.
vi.mock('./_shared/consultation-projection', () => ({
  projectNewMeetingTx: mockProjectNewMeeting,
  cancelProjectionTx: vi.fn(),
  softDeleteProjectionTx: vi.fn(),
  syncProjectionScheduleTx: vi.fn(),
}));

// `auditEventsRepository` is the mock boundary, NOT `_shared/meeting-audit.ts` — so
// `recordMeetingBooked` runs for real and its metadata fold (the ISO conversion, the context
// mapping) is genuinely exercised rather than stubbed away.
vi.mock('./audit-events', () => ({ auditEventsRepository: { record: mockRecord } }));

import { meetingsRepository } from './meetings';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const CONTEXT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '44444444-4444-4444-8444-444444444444';

const START = new Date('2026-09-07T09:00:00.000Z');
const END = new Date('2026-09-07T10:00:00.000Z');

const MEETING_ROW = { id: MEETING_ID, scheduledStart: START, scheduledEnd: END };

/** The order in which the transaction body's steps ran, for the ordering assertion. */
let callOrder: string[] = [];
/** The exact `tx` object handed to the transaction body — the identity under test. */
let capturedTx: unknown;

function baseInput(): Parameters<typeof meetingsRepository.create>[0] {
  return {
    scheduledStart: START,
    scheduledEnd: END,
    contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];

  mockMeetingReturning.mockImplementation(async () => {
    callOrder.push('insertMeeting');
    return [MEETING_ROW];
  });
  mockContextReturning.mockImplementation(async () => {
    callOrder.push('insertContexts');
    return [{ id: 'ctx_1', meetingId: MEETING_ID, contextType: 'case', contextId: CONTEXT_ID }];
  });
  mockProjectNewMeeting.mockImplementation(async () => {
    callOrder.push('project');
    return EXPERT_PROFILE_ID;
  });
  mockRecord.mockImplementation(async () => {
    callOrder.push('audit');
    return { id: 'audit_1' };
  });

  // A minimal `tx` satisfying the two insert chains `create` uses. The FIRST insert is the
  // meeting, the SECOND is the contexts — distinguished by call count, since a bare fake
  // cannot tell the two Drizzle table objects apart.
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    let insertCount = 0;
    capturedTx = {
      insert: () => {
        insertCount += 1;
        const returning = insertCount === 1 ? mockMeetingReturning : mockContextReturning;
        return { values: () => ({ returning }) };
      },
    };
    return fn(capturedTx);
  });
});

describe('meetingsRepository.create — the meeting.booked audit row (ADR-1044 §5 / ADR-1030)', () => {
  it('writes EXACTLY ONE meeting.booked row, on the meeting, with the booking actor', async () => {
    await meetingsRepository.create({ ...baseInput(), actorUserId: ACTOR_ID });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [row] = mockRecord.mock.calls[0] ?? [];
    expect(row).toMatchObject({
      actorUserId: ACTOR_ID,
      action: 'meeting.booked',
      entityType: 'meeting',
      entityId: MEETING_ID,
    });
  });

  it('carries the context, the window and the blocked expert in metadata', async () => {
    await meetingsRepository.create({ ...baseInput(), actorUserId: ACTOR_ID });

    const [row] = mockRecord.mock.calls[0] ?? [];
    expect((row as { metadata: unknown }).metadata).toEqual({
      contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
      // ISO STRINGS, not `Date`: `metadata` is jsonb, so a `Date` typed into it would be a lie
      // on the way back out. `recordMeetingBooked` converts once.
      scheduledStart: START.toISOString(),
      scheduledEnd: END.toISOString(),
      // WHOSE CALENDAR THIS BOOKING BLOCKED — resolved at write time, not re-derivable later.
      expertProfileId: EXPERT_PROFILE_ID,
    });
  });

  it('records the row on the BOOKING TRANSACTION, never the base db client', async () => {
    // ⚠ THE LOAD-BEARING ASSERTION OF THIS FILE. `auditEventsRepository.record` takes the
    // executor as its SECOND argument precisely so the audit row commits or rolls back with
    // the mutation. If that argument ever becomes the base `db`, the row survives a
    // rolled-back booking and attests to something that never happened — and no
    // real-database test can see the difference (see this file's header).
    await meetingsRepository.create({ ...baseInput(), actorUserId: ACTOR_ID });

    const [, exec] = mockRecord.mock.calls[0] ?? [];
    expect(exec).toBe(capturedTx);
  });

  it('writes the audit row AFTER the projection resolves the expert', async () => {
    await meetingsRepository.create({ ...baseInput(), actorUserId: ACTOR_ID });

    expect(callOrder).toEqual(['insertMeeting', 'insertContexts', 'project', 'audit']);
  });

  it('falls back to a NULL actor when none is passed — the ADR-1030 system-actor exemption', async () => {
    // The dev seeder's case: no human is behind a seed run, so the row is UNATTRIBUTED rather
    // than carrying a fabricated actor. `actor_user_id` is a nullable FK, so this is
    // representable without inventing a synthetic user.
    await meetingsRepository.create(baseInput());

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [row] = mockRecord.mock.calls[0] ?? [];
    expect((row as { actorUserId: unknown }).actorUserId).toBeNull();
  });

  it('passes an EXPLICIT null actor through unchanged', async () => {
    await meetingsRepository.create({ ...baseInput(), actorUserId: null });

    const [row] = mockRecord.mock.calls[0] ?? [];
    expect((row as { actorUserId: unknown }).actorUserId).toBeNull();
  });

  it('attempts NO audit write when the booking fails before the audit step', async () => {
    // A booking that throws inside the transaction never reaches the audit write, so there is
    // no row to roll back in the first place. The complementary direction — the audit insert
    // ITSELF failing and taking the whole booking down with it — needs real FK enforcement and
    // lives in `meetings.integration.test.ts`.
    mockProjectNewMeeting.mockRejectedValue(new Error('no resolvable expert'));

    await expect(
      meetingsRepository.create({ ...baseInput(), actorUserId: ACTOR_ID })
    ).rejects.toThrow('no resolvable expert');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('emits nothing when the contexts array is empty — the guard precedes every write', async () => {
    await expect(meetingsRepository.create({ ...baseInput(), contexts: [] })).rejects.toThrow();

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
