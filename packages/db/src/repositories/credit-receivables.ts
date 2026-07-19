import { and, asc, eq, isNull, lte, or, type SQL } from 'drizzle-orm';
import { db } from '../client';
import { creditReceivables, type CreditReceivable, type CreditReceivableReason } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** The row selector for `clear` — by `receivableId` (priority) or `sessionId`; one is required. */
function clearSelector(input: { sessionId?: string; receivableId?: string }): SQL {
  if (input.receivableId !== undefined) {
    return eq(creditReceivables.id, input.receivableId);
  }
  if (input.sessionId !== undefined) {
    return eq(creditReceivables.sessionId, input.sessionId);
  }
  throw new Error('creditReceivablesRepository.clear requires a sessionId or receivableId');
}

/** Input for opening (or idempotently returning) the receivable for a failed session. */
export interface OpenReceivableInput {
  companyId: string;
  walletId: string;
  sessionId: string;
  /** Unrecovered overdraft magnitude (positive AUD minor units). */
  amountMinor: number;
  reason: CreditReceivableReason;
  /** The failed / SCA PaymentIntent (recovery). */
  stripePaymentIntentId?: string | null;
}

/**
 * Result of `open`. `created` distinguishes a fresh insert from an idempotent hit on an
 * already-open receivable — callers publish dunning + analytics ONLY when `created` (so the
 * sync end-session path and the async `payment_intent.payment_failed` webhook, which both
 * open the SAME session receivable, dun exactly once — BAL-378 FIX 5).
 */
export interface OpenReceivableResult {
  receivable: CreditReceivable;
  created: boolean;
}

/**
 * creditReceivablesRepository (BAL-378 / ADR-1040 Lane 2) — the failed-settlement
 * receivable + soft-hold source. A company is soft-held iff it has ANY open receivable
 * (`hasOpenReceivable`), which gates `openSession`. Clearing the receivable (status →
 * `cleared`) releases that soft hold (§14 Q2). Reads/writes accept a `DbExecutor` so the
 * settlement webhook can open/clear WITHIN its own credit-applying txn.
 */
export const creditReceivablesRepository = {
  /**
   * Open the receivable for a failed session — IDEMPOTENT per session via the partial
   * UNIQUE `(session_id) WHERE deleted_at IS NULL`. A second `open` for the same session
   * conflicts and returns the EXISTING row rather than inserting a duplicate (there is at
   * most one receivable per session across its lifetime; the exactly-one-settlement-per-
   * session invariant guarantees no legitimate re-open after clear). TX-COMPOSABLE.
   *
   * Returns `{ receivable, created }` — `created=false` when the insert conflicted onto an
   * existing open receivable, so the caller can dun exactly once per failed session (FIX 5).
   */
  async open(input: OpenReceivableInput, exec: DbExecutor = db): Promise<OpenReceivableResult> {
    const [inserted] = await exec
      .insert(creditReceivables)
      .values({
        companyId: input.companyId,
        walletId: input.walletId,
        sessionId: input.sessionId,
        amountMinor: input.amountMinor,
        reason: input.reason,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      })
      .onConflictDoNothing({
        target: creditReceivables.sessionId,
        where: isNull(creditReceivables.deletedAt),
      })
      .returning();
    if (inserted !== undefined) {
      return { receivable: inserted, created: true };
    }

    // Conflict on the partial-unique — a receivable already exists for this session.
    const [existing] = await exec
      .select()
      .from(creditReceivables)
      .where(
        and(eq(creditReceivables.sessionId, input.sessionId), isNull(creditReceivables.deletedAt))
      )
      .limit(1);
    if (existing === undefined) {
      throw new Error(
        `credit_receivables open conflicted but no existing row was found for session ${input.sessionId}`
      );
    }
    return { receivable: existing, created: false };
  },

  /**
   * The soft-hold predicate: does this company have ANY open, non-deleted receivable? Rides
   * `credit_receivables_company_open_idx`. TX-COMPOSABLE so `openSession` can gate on it
   * under the same wallet-locked txn.
   */
  async hasOpenReceivable(companyId: string, exec: DbExecutor = db): Promise<boolean> {
    const [row] = await exec
      .select({ id: creditReceivables.id })
      .from(creditReceivables)
      .where(
        and(
          eq(creditReceivables.companyId, companyId),
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt)
        )
      )
      .limit(1);
    return row !== undefined;
  },

  /** All open, non-deleted receivables for a company, oldest-opened first. */
  async findOpenByCompany(companyId: string): Promise<CreditReceivable[]> {
    return db
      .select()
      .from(creditReceivables)
      .where(
        and(
          eq(creditReceivables.companyId, companyId),
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt)
        )
      )
      .orderBy(asc(creditReceivables.openedAt));
  },

  /**
   * Open, non-deleted receivables due for a dunning re-notify — never dunned, OR last
   * dunned at/before `notDunnedSince` (the daily sweep passes `now − cadence`). Oldest-
   * opened first. The cadence policy lives at the caller (the sweep), not the repo.
   */
  async listOpenForDunning(notDunnedSince: Date): Promise<CreditReceivable[]> {
    return db
      .select()
      .from(creditReceivables)
      .where(
        and(
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt),
          or(
            isNull(creditReceivables.lastDunningAt),
            lte(creditReceivables.lastDunningAt, notDunnedSince)
          )
        )
      )
      .orderBy(asc(creditReceivables.openedAt));
  },

  /** Stamp the dunning cadence anchor after a re-notify. Throws if the receivable is gone. */
  async markDunned(receivableId: string, now: Date = new Date()): Promise<CreditReceivable> {
    const [row] = await db
      .update(creditReceivables)
      .set({ lastDunningAt: now })
      .where(eq(creditReceivables.id, receivableId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit receivable not found: ${receivableId}`);
    }
    return row;
  },

  /**
   * Clear the open receivable (status → `cleared`, stamp `cleared_at`), releasing the soft
   * hold. Address it by `sessionId` (the webhook path — §14 Q2) or `receivableId` (a future
   * admin "mark paid"). Only an `open` receivable clears; returns `undefined` when there is
   * no open receivable to clear (idempotent no-op). TX-COMPOSABLE so the settlement webhook
   * clears in the same txn that marks the session settled.
   */
  async clear(
    input: { sessionId?: string; receivableId?: string; now?: Date },
    exec: DbExecutor = db
  ): Promise<CreditReceivable | undefined> {
    const now = input.now ?? new Date();
    const selector = clearSelector(input);

    const [row] = await exec
      .update(creditReceivables)
      .set({ status: 'cleared', clearedAt: now })
      .where(
        and(selector, eq(creditReceivables.status, 'open'), isNull(creditReceivables.deletedAt))
      )
      .returning();
    return row;
  },
};
