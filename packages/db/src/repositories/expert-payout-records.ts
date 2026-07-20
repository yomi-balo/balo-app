import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  expertPayoutRecords,
  type CreditFinalizationPath,
  type ExpertPayoutRecord,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * Input for booking a single expert payout obligation (BAL-399). `amountMinor` is a READ of
 * `credit_sessions.expertAccruedMinor` at finalization — never re-derived from minutes.
 * `idempotencyKey` is the deterministic `payout:${sessionId}` (the belt to the partial-unique
 * suspenders); `currency` falls to the column default ('AUD') when omitted.
 */
export interface RecordPayoutInput {
  sessionId: string;
  expertProfileId: string;
  companyId: string;
  amountMinor: number;
  durationMinutes: number;
  finalizationPath: CreditFinalizationPath;
  idempotencyKey: string;
  currency?: string;
}

/**
 * `record` outcome. `created=false` ⇒ the obligation already existed (the insert conflicted
 * onto the partial-unique) — the exactly-once guard callers gate ALL finalization side-effects
 * on (book the payout once, publish the receipt/payout notices once, fire analytics once).
 */
export interface RecordPayoutResult {
  record: ExpertPayoutRecord;
  created: boolean;
}

/**
 * Read the LIVE (non-soft-deleted) obligation for a session on the given executor. Uses
 * `exec` (not the base `db`) so the conflict re-read inside `record` observes a row inserted
 * earlier in the SAME uncommitted transaction.
 */
async function readLiveBySession(
  exec: DbExecutor,
  sessionId: string
): Promise<ExpertPayoutRecord | undefined> {
  const [row] = await exec
    .select()
    .from(expertPayoutRecords)
    .where(and(eq(expertPayoutRecords.sessionId, sessionId), isNull(expertPayoutRecords.deletedAt)))
    .limit(1);
  return row;
}

export const expertPayoutRecordsRepository = {
  /**
   * Book the expert payout obligation for a finalized session, EXACTLY ONCE. Mirrors
   * `creditReceivablesRepository.open`: `onConflictDoNothing` on the `session_id` PARTIAL
   * unique (arbiter predicate `deleted_at IS NULL` matches `expert_payout_records_session_uq`)
   * → a first write returns `{ created: true }`; a replay conflicts, DO NOTHING, and the row is
   * re-read → `{ created: false }`. TX-COMPOSABLE: pass `exec` (the caller's `tx`) so the
   * obligation commits or rolls back WITH `finalizeBilling`'s flow; defaults to the base `db`.
   *
   * A soft-deleted prior obligation is NOT in the partial-unique index, so `record` re-inserts
   * a fresh live row (`created: true`) after a soft-delete — the intended re-record path. The
   * `amount_minor >= 0` / `duration_minutes >= 0` CHECKs backstop the inputs (raw 23514 throw).
   */
  async record(input: RecordPayoutInput, exec: DbExecutor = db): Promise<RecordPayoutResult> {
    const [inserted] = await exec
      .insert(expertPayoutRecords)
      .values({
        sessionId: input.sessionId,
        expertProfileId: input.expertProfileId,
        companyId: input.companyId,
        amountMinor: input.amountMinor,
        durationMinutes: input.durationMinutes,
        finalizationPath: input.finalizationPath,
        idempotencyKey: input.idempotencyKey,
        ...(input.currency === undefined ? {} : { currency: input.currency }),
      })
      .onConflictDoNothing({
        target: expertPayoutRecords.sessionId, // arbiter = the PARTIAL unique index
        where: isNull(expertPayoutRecords.deletedAt), // predicate MUST match the index exactly
      })
      .returning();

    if (inserted !== undefined) {
      return { record: inserted, created: true };
    }

    // Conflict on the partial-unique — the obligation already exists for this session. Re-read
    // on the SAME executor so an in-flight tx observes its own prior insert.
    const existing = await readLiveBySession(exec, input.sessionId);
    if (existing === undefined) {
      throw new Error(
        `expert_payout_records.record conflicted but no live record was found for session ${input.sessionId}`
      );
    }
    return { record: existing, created: false };
  },

  /** The live payout obligation for a session, if any (drives the expert money-block payout line). */
  async findBySession(sessionId: string): Promise<ExpertPayoutRecord | undefined> {
    return readLiveBySession(db, sessionId);
  },

  /**
   * The expert's live, still-`recorded` obligations, newest first — the future payout-run
   * (BAL-202/203) candidate set + the expert earnings surface (BAL-133/388 reuse). Disbursed
   * (`paid`/`disbursing`/`failed`) and soft-deleted rows are excluded.
   */
  async listRecordedForExpert(expertProfileId: string): Promise<ExpertPayoutRecord[]> {
    return db
      .select()
      .from(expertPayoutRecords)
      .where(
        and(
          eq(expertPayoutRecords.expertProfileId, expertProfileId),
          eq(expertPayoutRecords.status, 'recorded'),
          isNull(expertPayoutRecords.deletedAt)
        )
      )
      .orderBy(desc(expertPayoutRecords.recordedAt));
  },
};
