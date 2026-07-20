import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { creditSessions, expertPayoutRecords } from '../schema';
import { creditWalletFactory, expertFactory, userFactory } from '../test/factories';
import { expertPayoutRecordsRepository, type RecordPayoutInput } from './expert-payout-records';

/**
 * Integration tests for `expertPayoutRecordsRepository` (BAL-399). Covers the exactly-once
 * `record` guard (double call → one row, `created=false` on the replay, incl. a same-transaction
 * replay), the soft-delete re-record path (partial-unique on `deleted_at IS NULL`),
 * `findBySession`, `listRecordedForExpert` (status + soft-delete + expert scoping, newest-first),
 * and the amount/duration CHECK constraints. Factories only; direct `credit_sessions` insert
 * (there is no session factory).
 */

interface SeededSession {
  sessionId: string;
  expertProfileId: string;
  companyId: string;
}

/**
 * Seed a minimal LIVE `credit_sessions` row plus the wallet/company/expert/member it
 * FK-references (all RESTRICT). Pass `expertProfileId` to book multiple obligations for the
 * SAME expert (the `listRecordedForExpert` fan-in). Snapshot columns are set to valid positive
 * values to satisfy the session CHECKs; the session's economics are irrelevant to these tests.
 */
async function seedSession(opts: { expertProfileId?: string } = {}): Promise<SeededSession> {
  const { wallet, companyId } = await creditWalletFactory();
  const expertProfileId = opts.expertProfileId ?? (await expertFactory()).id;
  const member = await userFactory();
  const [session] = await db
    .insert(creditSessions)
    .values({
      walletId: wallet.id,
      companyId,
      expertProfileId,
      initiatingMemberId: member.id,
      estimatedMinutes: 10,
      expertRateMinorPerHour: 12_000,
      clientRateMinorPerMinute: 250,
      expertRateMinorPerMinute: 200,
      effectiveCeilingMinor: 15_000,
    })
    .returning();
  if (session === undefined) throw new Error('credit session seed failed');
  return { sessionId: session.id, expertProfileId, companyId };
}

/** Standard `record` input for a seeded session (deterministic `payout:${sessionId}` key). */
function payoutInput(s: SeededSession, over: Partial<RecordPayoutInput> = {}): RecordPayoutInput {
  return {
    sessionId: s.sessionId,
    expertProfileId: s.expertProfileId,
    companyId: s.companyId,
    amountMinor: 2000,
    durationMinutes: 10,
    finalizationPath: 'live_capture',
    idempotencyKey: `payout:${s.sessionId}`,
    ...over,
  };
}

describe('expertPayoutRecordsRepository.record', () => {
  it('books an obligation with defaults (currency AUD, status recorded, recordedAt set)', async () => {
    const s = await seedSession();
    const { record, created } = await expertPayoutRecordsRepository.record(
      payoutInput(s, { amountMinor: 11_250, durationMinutes: 45, finalizationPath: 'confirmed' })
    );

    expect(created).toBe(true);
    expect(record.sessionId).toBe(s.sessionId);
    expect(record.expertProfileId).toBe(s.expertProfileId);
    expect(record.companyId).toBe(s.companyId);
    expect(record.amountMinor).toBe(11_250);
    expect(record.durationMinutes).toBe(45);
    expect(record.finalizationPath).toBe('confirmed');
    expect(record.currency).toBe('AUD');
    expect(record.status).toBe('recorded');
    expect(record.idempotencyKey).toBe(`payout:${s.sessionId}`);
    expect(record.recordedAt).toBeInstanceOf(Date);
    expect(record.deletedAt).toBeNull();
  });

  it('honours an explicit currency override', async () => {
    const s = await seedSession();
    const { record } = await expertPayoutRecordsRepository.record(
      payoutInput(s, { currency: 'USD' })
    );
    expect(record.currency).toBe('USD');
  });

  it('is exactly-once: a replay returns created=false and inserts no second row', async () => {
    const s = await seedSession();
    const first = await expertPayoutRecordsRepository.record(payoutInput(s));
    expect(first.created).toBe(true);

    const second = await expertPayoutRecordsRepository.record(payoutInput(s));
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);

    const rows = await db
      .select()
      .from(expertPayoutRecords)
      .where(eq(expertPayoutRecords.sessionId, s.sessionId));
    expect(rows).toHaveLength(1);
  });

  it('composes under a caller transaction (exec) and commits with it', async () => {
    const s = await seedSession();
    const res = await db.transaction((tx) =>
      expertPayoutRecordsRepository.record(payoutInput(s), tx)
    );
    expect(res.created).toBe(true);
    const found = await expertPayoutRecordsRepository.findBySession(s.sessionId);
    expect(found?.id).toBe(res.record.id);
  });

  it('a same-transaction replay observes its own prior insert (created=false)', async () => {
    const s = await seedSession();
    const res = await db.transaction(async (tx) => {
      const a = await expertPayoutRecordsRepository.record(payoutInput(s), tx);
      const b = await expertPayoutRecordsRepository.record(payoutInput(s), tx);
      return { a, b };
    });
    expect(res.a.created).toBe(true);
    expect(res.b.created).toBe(false);
    expect(res.b.record.id).toBe(res.a.record.id);
  });
});

describe('expertPayoutRecordsRepository — soft-delete re-record (partial unique)', () => {
  it('re-inserts a fresh live obligation after the prior one is soft-deleted', async () => {
    const s = await seedSession();
    const first = await expertPayoutRecordsRepository.record(payoutInput(s));
    expect(first.created).toBe(true);

    // Soft-delete drops the row out of BOTH partial-unique indexes (session + idempotency key).
    await db
      .update(expertPayoutRecords)
      .set({ deletedAt: new Date() })
      .where(eq(expertPayoutRecords.id, first.record.id));

    const second = await expertPayoutRecordsRepository.record(payoutInput(s));
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);

    // Two physical rows, exactly one live.
    const all = await db
      .select()
      .from(expertPayoutRecords)
      .where(eq(expertPayoutRecords.sessionId, s.sessionId));
    expect(all).toHaveLength(2);
    const live = await db
      .select()
      .from(expertPayoutRecords)
      .where(
        and(eq(expertPayoutRecords.sessionId, s.sessionId), isNull(expertPayoutRecords.deletedAt))
      );
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(second.record.id);
  });
});

describe('expertPayoutRecordsRepository.findBySession', () => {
  it('returns the live obligation; undefined for unknown and soft-deleted', async () => {
    const s = await seedSession();
    expect(await expertPayoutRecordsRepository.findBySession(s.sessionId)).toBeUndefined();

    const { record } = await expertPayoutRecordsRepository.record(payoutInput(s));
    const found = await expertPayoutRecordsRepository.findBySession(s.sessionId);
    expect(found?.id).toBe(record.id);

    expect(
      await expertPayoutRecordsRepository.findBySession('00000000-0000-0000-0000-000000000000')
    ).toBeUndefined();

    await db
      .update(expertPayoutRecords)
      .set({ deletedAt: new Date() })
      .where(eq(expertPayoutRecords.id, record.id));
    expect(await expertPayoutRecordsRepository.findBySession(s.sessionId)).toBeUndefined();
  });
});

describe('expertPayoutRecordsRepository.listRecordedForExpert', () => {
  it('lists the expert recorded obligations newest-first; excludes others / non-recorded / deleted', async () => {
    const expert = await expertFactory();
    const s1 = await seedSession({ expertProfileId: expert.id });
    const s2 = await seedSession({ expertProfileId: expert.id });
    const s3 = await seedSession({ expertProfileId: expert.id });

    const r1 = (await expertPayoutRecordsRepository.record(payoutInput(s1))).record;
    const r2 = (await expertPayoutRecordsRepository.record(payoutInput(s2))).record;
    const r3 = (await expertPayoutRecordsRepository.record(payoutInput(s3))).record;

    // Stagger recordedAt so the desc order is deterministic (now() ties within one txn).
    await db
      .update(expertPayoutRecords)
      .set({ recordedAt: new Date('2027-01-01T00:00:00.000Z') })
      .where(eq(expertPayoutRecords.id, r1.id));
    await db
      .update(expertPayoutRecords)
      .set({ recordedAt: new Date('2027-01-02T00:00:00.000Z') })
      .where(eq(expertPayoutRecords.id, r2.id));
    await db
      .update(expertPayoutRecords)
      .set({ recordedAt: new Date('2027-01-03T00:00:00.000Z') })
      .where(eq(expertPayoutRecords.id, r3.id));

    // Same expert but status advanced past 'recorded' → excluded.
    const s4 = await seedSession({ expertProfileId: expert.id });
    const r4 = (await expertPayoutRecordsRepository.record(payoutInput(s4))).record;
    await db
      .update(expertPayoutRecords)
      .set({ status: 'disbursing' })
      .where(eq(expertPayoutRecords.id, r4.id));

    // Same expert but soft-deleted → excluded.
    const s5 = await seedSession({ expertProfileId: expert.id });
    const r5 = (await expertPayoutRecordsRepository.record(payoutInput(s5))).record;
    await db
      .update(expertPayoutRecords)
      .set({ deletedAt: new Date() })
      .where(eq(expertPayoutRecords.id, r5.id));

    // A different expert's obligation → excluded.
    const other = await seedSession();
    await expertPayoutRecordsRepository.record(payoutInput(other));

    const list = await expertPayoutRecordsRepository.listRecordedForExpert(expert.id);
    expect(list.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
  });

  it('returns an empty array for an expert with no obligations', async () => {
    const expert = await expertFactory();
    expect(await expertPayoutRecordsRepository.listRecordedForExpert(expert.id)).toEqual([]);
  });
});

describe('expertPayoutRecordsRepository — CHECK constraints', () => {
  it('rejects a negative amount_minor', async () => {
    const s = await seedSession();
    await expect(
      expertPayoutRecordsRepository.record(payoutInput(s, { amountMinor: -1 }))
    ).rejects.toThrow();
  });

  it('rejects a negative duration_minutes', async () => {
    const s = await seedSession();
    await expect(
      expertPayoutRecordsRepository.record(payoutInput(s, { durationMinutes: -1 }))
    ).rejects.toThrow();
  });

  it('accepts a zero amount and duration (>= 0 boundary — a sub-minute session accrues 0)', async () => {
    const s = await seedSession();
    const { record, created } = await expertPayoutRecordsRepository.record(
      payoutInput(s, { amountMinor: 0, durationMinutes: 0 })
    );
    expect(created).toBe(true);
    expect(record.amountMinor).toBe(0);
    expect(record.durationMinutes).toBe(0);
  });
});
