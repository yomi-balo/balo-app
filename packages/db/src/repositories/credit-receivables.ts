import { and, asc, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { amountNeededToClearHold, type HoldStatus } from '@balo/shared/credit';
import { db } from '../client';
import {
  companies,
  creditReceivables,
  creditSessions,
  creditWallets,
  type CreditReceivable,
  type CreditReceivableReason,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { creditLedgerRepository } from './credit-ledger';

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
 * BAL-548 / ADR-1055 — one open receivable, projected for the pending-actions queue. See
 * {@link creditReceivablesRepository.listOpen}.
 *
 * ⚠ `amountMinor` IS AUD MINOR UNITS, and the alert stores a PRE-FORMATTED string. The finder
 * formats once, at the moment the evidence is captured; nothing re-formats it later against a
 * display-FX rate that has since moved.
 */
export interface OpenReceivableAlertRow {
  receivableId: string;
  companyId: string;
  companyName: string;
  amountMinor: number;
  reason: CreditReceivableReason;
  openedAt: Date;
  lastDunningAt: Date | null;
  stripePaymentIntentId: string | null;
}

/**
 * BAL-474 (plan §G.2) — one wallet due its daily dunning reminder. See
 * {@link creditReceivablesRepository.listWalletsDueForDailyDunning}.
 */
export interface DailyDunningDueWallet {
  walletId: string;
  companyId: string;
}

/**
 * creditReceivablesRepository (BAL-378 / ADR-1040 Lane 2) — the failed-settlement
 * receivable + soft-hold source. A company is soft-held iff it has ANY open receivable
 * (`hasOpenReceivable`). The hold gates the GATED session open, auto-top-up, card removal
 * AND — since BAL-474 (ADR-1040 Amendment 7 §H) — new Case BOOKINGS; the presence seam's
 * overdraft-tolerant open passes through it (a consultation already booked still runs and bills
 * its own share). Clearing the receivable (status → `cleared`) releases that soft hold (§14 Q2).
 * Reads/writes accept a `DbExecutor` so the settlement webhook can open/clear WITHIN its own
 * credit-applying txn.
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

  /**
   * BAL-535 (ADR-1040 Amendment 6 §F, fix round B1) — the moment the OLDEST debt still open on
   * this wallet became outstanding: `MIN(COALESCE(session.ended_at, receivable.opened_at))`
   * over every open, non-deleted receivable. `undefined` when the wallet owes nothing.
   *
   * ⚠ WHY `session.ended_at` AND NOT SIMPLY `opened_at`. The debt exists from the moment the
   * session ended and its terminal overdraft was computed; the receivable row is only the
   * record of it, and on the LATE-OPEN (R3b) paths that row is inserted hours later — in the
   * very transaction that then asks whether the debt is covered. Anchoring on `opened_at`
   * there would give a window of zero width and a promo discount of zero, i.e. exactly the
   * vacuous gate B1 exists to remove. `COALESCE` keeps a session that somehow never stamped
   * `ended_at` anchored on the receivable instead of dropping out of the MIN.
   *
   * The MIN (rather than a per-row anchor) is the conservative choice: the widest window
   * discounts the most promo credit, so a wallet-wide clear can only ever be made STRICTER by
   * an older sibling debt, never laxer.
   *
   * ⚠⚠ WHY THE SESSION JOIN IS A `LEFT JOIN` FILTERED ON `deleted_at` (fix round 2, F1). Every
   * other session read in the data layer is `deleted_at IS NULL`-scoped; this one was not, so a
   * SOFT-DELETED session's (older) `ended_at` still entered the MIN. That widens the promo
   * window, inflates the discount and REFUSES a covering credit — the soft hold then persists on
   * a company that has already paid. It fails CLOSED, which is why no test caught it.
   *
   * ⚠ THE FILTER BELONGS IN THE JOIN CONDITION, NEVER IN THE `WHERE`. `hasOpenReceivable` — the
   * predicate that actually holds the company — reads `credit_receivables` alone and knows
   * nothing about sessions, so a receivable whose session was soft-deleted STILL holds that
   * company. Filtering in the `WHERE` (with the join left INNER) would drop such a row from the
   * aggregate entirely: an `undefined` anchor makes `assessCashCoverage` report
   * `hasOpenReceivable: false`, so no covering credit could EVER clear it — the same fail-closed
   * harm, made permanent. As a `LEFT JOIN` the row stays in the MIN and simply falls through
   * `COALESCE` onto its own `opened_at`, the same fallback the never-stamped-`ended_at` case
   * already takes.
   *
   * TX-COMPOSABLE — read inside the same transaction (and under the same wallet advisory lock)
   * as the clear it gates.
   */
  async earliestOpenDebtAnchor(walletId: string, exec: DbExecutor = db): Promise<Date | undefined> {
    const [row] = await exec
      .select({
        anchor: sql<
          Date | string | null
        >`min(coalesce(${creditSessions.endedAt}, ${creditReceivables.openedAt}))`,
      })
      .from(creditReceivables)
      .leftJoin(
        creditSessions,
        and(eq(creditReceivables.sessionId, creditSessions.id), isNull(creditSessions.deletedAt))
      )
      .where(
        and(
          eq(creditReceivables.walletId, walletId),
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt)
        )
      );
    const anchor = row?.anchor;
    if (anchor === null || anchor === undefined) {
      return undefined;
    }
    // A raw aggregate is not routed through the column's driver mapper, so the value arrives
    // as whatever `postgres-js` decoded — a `Date` today, a string if that ever changes.
    return anchor instanceof Date ? anchor : new Date(anchor);
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
   * BAL-548 / ADR-1055 — the `receivable.open` finder read: every OPEN receivable opened at or
   * before `openedBefore`, OLDEST FIRST, with the company's name flattened on.
   *
   * ⚠⚠ A SEPARATE METHOD FROM THE DUNNING READS, AND THEY MUST NOT BE MERGED. The dunning due
   * set (`listWalletsDueForDailyDunning`, BAL-474 — wallet grain, keyed on `last_dunning_at`) is
   * the dunning sweep's; this is the alert queue's. Merging them would couple two sweeps with
   * different cadences and different failure modes onto one query — the alert queue would start
   * (or stop) firing because the dunning cadence changed.
   *
   * ⚠ THE ALERT'S GRAIN IS THE COMPANY, NOT THE RECEIVABLE. The row reads "Northwind
   * Industrial owes A$62.40", and a company with two open receivables is ONE problem for ONE
   * person, so the finder keys the alert on `companyId` and carries `receivableId` in the
   * evidence. This read still returns ONE ROW PER RECEIVABLE — folding is the finder's job,
   * because only it knows how to word the combined sentence.
   *
   * ⚠ `limit` IS A BATCH BOUND THE CALLER MUST WARN ABOUT WHEN IT FILLS. No silent caps.
   *
   * ⚠ `companies` HAS NO `deleted_at` (memory `reference_companies_table_no_deleted_at`), so
   * the INNER JOIN carries no soft-delete term. Do not add one.
   *
   * Rides `credit_receivables_open_queue_idx` (`opened_at` WHERE `status = 'open' AND
   * deleted_at IS NULL`) — `credit_receivables_company_open_idx` cannot serve it: it is keyed
   * on `company_id` and neither orders nor bounds.
   */
  async listOpen(openedBefore: Date, limit: number): Promise<OpenReceivableAlertRow[]> {
    return db
      .select({
        receivableId: creditReceivables.id,
        companyId: creditReceivables.companyId,
        companyName: companies.name,
        amountMinor: creditReceivables.amountMinor,
        reason: creditReceivables.reason,
        openedAt: creditReceivables.openedAt,
        lastDunningAt: creditReceivables.lastDunningAt,
        stripePaymentIntentId: creditReceivables.stripePaymentIntentId,
      })
      .from(creditReceivables)
      .innerJoin(companies, eq(companies.id, creditReceivables.companyId))
      .where(
        and(
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt),
          lte(creditReceivables.openedAt, openedBefore)
        )
      )
      .orderBy(asc(creditReceivables.openedAt), asc(creditReceivables.id))
      .limit(limit);
  },

  /**
   * BAL-474 (ADR-1040 Amendment 7 §G.1, plan AD-12 / D7.2) — THE ONE READER of a wallet's soft
   * hold and of the top-up that clears it. Every surface that quotes the figure reads it here: the
   * dunning claim (under the wallet advisory lock), the booking funding snapshot, the heal.
   *
   * The figure is `amountNeededToClearHold(balance, promo)` — computed from the SAME two inputs the
   * coverage clear judges (`earliestOpenDebtAnchor` + `creditLedgerRepository.sumPromoGrantedSince`),
   * so "a top-up of this amount or more" provably clears. Zero (and no promo read) when nothing is
   * open.
   *
   * ⚠ ONE SNAPSHOT (D7.2, R3-F6b). Called WITHOUT `exec`, every read runs inside its own
   * `REPEATABLE READ, READ ONLY` transaction, so a top-up committing between two reads can never
   * produce `onHold: true` with a figure computed from a different moment. Called WITH `exec`, the
   * caller vouches for consistency — the dunning claim holds the wallet advisory lock, and the
   * booking snapshot is itself one repeatable-read transaction.
   */
  async readHoldStatus(input: { walletId: string }, exec?: DbExecutor): Promise<HoldStatus> {
    const read = async (tx: DbExecutor): Promise<HoldStatus> => {
      const [open] = await tx
        .select({
          count: sql<number>`cast(count(*) as int)`,
          confirmationWasRequested: sql<boolean>`coalesce(bool_or(${creditReceivables.reason} = 'settlement_requires_action'), false)`,
        })
        .from(creditReceivables)
        .where(
          and(
            eq(creditReceivables.walletId, input.walletId),
            eq(creditReceivables.status, 'open'),
            isNull(creditReceivables.deletedAt)
          )
        );
      const [wallet] = await tx
        .select({ balanceMinor: creditWallets.balanceMinor })
        .from(creditWallets)
        .where(eq(creditWallets.id, input.walletId))
        .limit(1);
      const balanceMinor = wallet?.balanceMinor ?? 0;
      const openReceivableCount = Number(open?.count ?? 0);
      if (openReceivableCount === 0) {
        return {
          onHold: false,
          openReceivableCount: 0,
          confirmationWasRequested: false,
          balanceMinor,
          promoGrantedSinceDebtMinor: 0,
          amountToClearMinor: 0,
        };
      }
      const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(input.walletId, tx);
      const promoGrantedSinceDebtMinor =
        anchor === undefined
          ? 0
          : await creditLedgerRepository.sumPromoGrantedSince(
              { walletId: input.walletId, since: anchor },
              tx
            );
      return {
        onHold: true,
        openReceivableCount,
        confirmationWasRequested: open?.confirmationWasRequested === true,
        balanceMinor,
        promoGrantedSinceDebtMinor,
        amountToClearMinor: amountNeededToClearHold(balanceMinor, promoGrantedSinceDebtMinor),
      };
    };
    if (exec !== undefined) {
      return read(exec);
    }
    return db.transaction((tx) => read(tx), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  },

  /**
   * BAL-474 (ADR-1040 Amendment 7 §G.2, D7.1) — the wallets due their DAILY dunning reminder:
   * WALLET grain (one notice per wallet quoting the total top-up, never one per receivable),
   * over open, non-deleted receivables, due when the wallet's LATEST daily stamp is NULL or at or
   * before `notRemindedSince` (the sweep passes `now − DUNNING_CADENCE_HOURS`).
   *
   * ⚠ FAIRNESS ORDER (V4-F5): least-recently reminded first — `MAX(last_dunning_at) ASC NULLS
   * FIRST, wallet_id` — so a batch that FILLS can never keep starving the same tail: each day's
   * leftovers lead the next day's batch. ⚠ `limit` is a batch bound the CALLER must warn about
   * when it fills.
   *
   * `last_dunning_at` is written ONLY by the daily arm ({@link stampDailyDunning}); a
   * `receivable_opened` notice never stamps, so it never pushes the due set back (R3-F1).
   */
  async listWalletsDueForDailyDunning(
    notRemindedSince: Date,
    limit = 100
  ): Promise<DailyDunningDueWallet[]> {
    const lastReminded = sql`max(${creditReceivables.lastDunningAt})`;
    return db
      .select({ walletId: creditReceivables.walletId, companyId: creditReceivables.companyId })
      .from(creditReceivables)
      .where(and(eq(creditReceivables.status, 'open'), isNull(creditReceivables.deletedAt)))
      .groupBy(creditReceivables.walletId, creditReceivables.companyId)
      .having(
        or(
          sql`${lastReminded} IS NULL`,
          sql`${lastReminded} <= ${notRemindedSince.toISOString()}::timestamptz`
        )
      )
      .orderBy(sql`${lastReminded} ASC NULLS FIRST`, asc(creditReceivables.walletId))
      .limit(limit);
  },

  /**
   * BAL-474 (§G.2) — stamp the DAILY reminder on every open, non-deleted receivable of the wallet
   * and return their ids. Written by the dunning claim INSIDE its wallet-locked transaction, before
   * the post-commit publish: the due set is re-evaluated daily, so a lost publish costs one cadence,
   * never permanent silence. The ONLY writer of `last_dunning_at`.
   */
  async stampDailyDunning(walletId: string, now: Date, exec: DbExecutor = db): Promise<string[]> {
    const rows = await exec
      .update(creditReceivables)
      .set({ lastDunningAt: now })
      .where(
        and(
          eq(creditReceivables.walletId, walletId),
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt)
        )
      )
      .returning({ id: creditReceivables.id });
    return rows.map((row) => row.id);
  },

  /**
   * BAL-474 (§G.2) — the wallet's latest daily-reminder stamp over its open, non-deleted
   * receivables, or `undefined` when it was never reminded. The claim reads it under the wallet
   * lock to answer `already_reminded` when two sweeps race.
   */
  async lastDailyDunningAt(walletId: string, exec: DbExecutor = db): Promise<Date | undefined> {
    const [row] = await exec
      .select({ last: sql<Date | string | null>`max(${creditReceivables.lastDunningAt})` })
      .from(creditReceivables)
      .where(
        and(
          eq(creditReceivables.walletId, walletId),
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt)
        )
      );
    const last = row?.last;
    if (last === null || last === undefined) {
      return undefined;
    }
    // A raw aggregate is not routed through the column's driver mapper — see
    // `earliestOpenDebtAnchor` for the same normalisation.
    return last instanceof Date ? last : new Date(last);
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

  /**
   * Clear EVERY open, non-deleted receivable on a wallet (status → `cleared`, stamp
   * `cleared_at`), releasing the company's soft hold. BAL-535 / ADR-1040 Amendment 6 §F — the
   * covering-credit exit. TX-COMPOSABLE so the Stripe webhook clears in the SAME transaction as
   * the ledger credit that covered the debt; a crash can therefore never leave a paid debt held.
   *
   * ⚠ A SEPARATE METHOD, NOT A THIRD ARM ON `clear()`. `clear()` destructures a single row
   * (`const [row] = …`), which is correct for its session/receivable selectors (both address at
   * most one row) and would SILENTLY DROP rows for a wallet-wide selector. Returning the array is
   * what lets the caller audit each cleared row individually.
   *
   * Idempotent — matches only `status = 'open'`, so a replay (or a wallet with nothing open)
   * returns `[]` and writes nothing.
   */
  async clearOpenForWallet(
    input: { walletId: string; now?: Date },
    exec: DbExecutor = db
  ): Promise<CreditReceivable[]> {
    const now = input.now ?? new Date();
    return exec
      .update(creditReceivables)
      .set({ status: 'cleared', clearedAt: now })
      .where(
        and(
          eq(creditReceivables.walletId, input.walletId),
          eq(creditReceivables.status, 'open'),
          isNull(creditReceivables.deletedAt)
        )
      )
      .returning();
  },
};
