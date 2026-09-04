import { and, asc, eq, gt, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  creditWallets,
  type CreditWallet,
  type MandateStatus,
  type NewCreditWallet,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';

/** Config fields a MANAGE_BILLING-gated action may write (gating lives at the caller). */
interface UpdateWalletConfigInput {
  lowBalanceMode?: CreditWallet['lowBalanceMode'];
  topupThresholdMinor?: number;
  topupReloadMinor?: number;
  /** Nullable: pass `null` to clear back to the platform default read at the caller. */
  overdraftCeilingMinor?: number | null;
  /** Nullable: off-session mandate secrets (card-funded). */
  stripePaymentMethodId?: string | null;
  mandateRef?: string | null;
}

/**
 * The DISPLAY facts of a saved card — never credentials. Brand, last4 and expiry are what a
 * checkout prints back at the cardholder; none of them can charge anything (the id in
 * `stripe_payment_method_id` is what does that). Written ONLY from webhook effects, via
 * `applyMandate`'s optional `card` or `applySavedCardDisplay`.
 *
 * The schema's `credit_wallets_card_display_all_or_none` CHECK is why this is one object and
 * not four optional fields: a partial write is a bug, not a state.
 */
export interface CardDisplayInput {
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: number;
  cardExpYear: number;
}

/**
 * BAL-521 — WHICH DOOR removed the saved card. A card can leave a wallet two ways: a client
 * pressing Remove (`user_initiated`, `detachSavedCard`) or Stripe's inbound
 * `payment_method.detached` webhook (`stripe_webhook` — the bank, the card provider, or a
 * Dashboard action). Both land on the SAME audit `action`
 * (`credit_wallet.saved_card_detached`); the audit `action` NEVER encodes the door, `source`
 * does. That is what lets ONE query answer "how did this wallet lose its card?".
 */
export type SavedCardDetachSource = 'user_initiated' | 'stripe_webhook';

/**
 * BAL-515/BAL-521 — the RECONCILABLE-STUCK predicate, defined ONCE so the finder
 * (`findStuckPendingTopups`) and the backlog count (`countAlarmedPendingTopups`) can never
 * describe different row sets. The count exists to size the backlog the finder's `LIMIT` only
 * reaches a slice of; two hand-written copies of these three arms would make that figure a lie
 * the moment one copy changed.
 *
 * Three arms, all mandatory: a marker exists, it has stood since at or before `cutoff`, and it
 * carries the crossing correlation without which nothing can derive the ledger key
 * `auto_topup:{walletId}:{triggeringEntryId}`.
 */
function stuckPendingTopupWhere(cutoff: Date): SQL | undefined {
  return and(
    isNotNull(creditWallets.pendingTopupAt),
    lte(creditWallets.pendingTopupAt, cutoff),
    isNotNull(creditWallets.pendingTopupTriggeringEntryId)
  );
}

export const creditWalletsRepository = {
  /**
   * Create the single wallet for a company. Config columns fall to their schema
   * defaults (`balance_minor` 0, `low_balance_mode` 'notify_only', threshold/reload
   * $20/$100). Raw unique violation (23505) if a wallet already exists for the company
   * (the `credit_wallets_company_idx` guarantees one-per-company).
   */
  async create(input: { companyId: string }): Promise<CreditWallet> {
    const [row] = await db.insert(creditWallets).values({ companyId: input.companyId }).returning();
    if (row === undefined) {
      throw new Error('Failed to create credit wallet');
    }
    return row;
  },

  /**
   * Find-or-create the single wallet for a company — TX-COMPOSABLE (pass a `tx` to run
   * inside a parent transaction, or the base `db` standalone) and RACE-SAFE. This is the
   * wallet-provisioning primitive `promoCodesRepository.redeem` calls to materialise a
   * wallet on a client's first-ever credit event (a promo grant with no prior purchase).
   *
   * Unlike `create` (which raw-throws 23505 when two concurrent first-redeems collide on
   * the `credit_wallets_company_idx` unique), this: SELECTs by `companyId` → returns an
   * existing wallet; else INSERTs with `onConflictDoNothing` on that same unique arbiter →
   * returns the freshly-created row; else (the insert returned nothing because a concurrent
   * first-redeem committed between our SELECT and INSERT) re-SELECTs and returns the winner.
   * The only throw is a true fault (the wallet vanished after a conflict — impossible under
   * the CASCADE-only FK, so it signals corruption).
   */
  async ensureForCompany(exec: DbExecutor, companyId: string): Promise<CreditWallet> {
    const [existing] = await exec
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.companyId, companyId))
      .limit(1);
    if (existing !== undefined) {
      return existing;
    }

    const [created] = await exec
      .insert(creditWallets)
      .values({ companyId })
      // Arbiter = `credit_wallets_company_idx` (the one-wallet-per-company unique).
      .onConflictDoNothing({ target: creditWallets.companyId })
      .returning();
    if (created !== undefined) {
      return created;
    }

    // A concurrent first-redeem inserted between our SELECT and INSERT → re-select the winner.
    const [raced] = await exec
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.companyId, companyId))
      .limit(1);
    if (raced === undefined) {
      throw new Error(`ensureForCompany: wallet vanished for company ${companyId}`);
    }
    return raced;
  },

  /**
   * Wallet by id (no soft-delete on this table). TX-COMPOSABLE: pass a `tx` to read UNDER a
   * parent transaction's advisory lock (BAL-379 auto-top-up Phase 1 needs the wallet in the
   * SAME locked snapshot as the guard reads — the base `db` reads on a DIFFERENT connection,
   * outside any lock the caller holds), or omit `exec` to read standalone on the base `db`.
   */
  async findById(id: string, exec: DbExecutor = db): Promise<CreditWallet | undefined> {
    const [row] = await exec.select().from(creditWallets).where(eq(creditWallets.id, id)).limit(1);
    return row;
  },

  /**
   * BAL-379 + BAL-515 — ARM the auto-top-up single-in-flight marker WITH the crossing it belongs
   * to, in ONE statement.
   *
   * ⚠ THIS REPLACES `setPendingTopupAt(walletId, date)`, which is DELETED rather than kept
   * alongside. `pending_topup_at` on its own is a bare timestamp: it says a reload is in flight
   * but not WHICH one, so nothing downstream could derive the crossing's ledger key
   * (`auto_topup:{walletId}:{triggeringEntryId}`) and test it for absence — which is exactly how
   * a charged-but-uncredited reload became invisible once the marker self-healed. Keeping a
   * timestamp-only writer would let a future caller silently re-open that hole; there is no
   * legitimate arm without a correlation.
   *
   * `pending_topup_payment_intent_id` is NULLED here, not left: a fresh crossing has no
   * PaymentIntent yet (phase 2 has not run), and inheriting the previous crossing's id would
   * point the reconcile at the wrong charge.
   *
   * ⚠ BAL-521 (AMEND-9) — `pending_topup_alarmed_at` IS NULLED IN THE SAME STATEMENT, and that is
   * a money guard, not tidiness. The column is the reconcile sweep's rotation cursor: a stamped
   * row is de-prioritised behind every never-alarmed one. A legitimate TTL re-arm inheriting the
   * PREVIOUS crossing's stamp would therefore push a NEW, LIVE, in-flight reload to the back of
   * the batch — silently, and in exactly the way the rotation exists to prevent. A fresh crossing
   * has never alarmed, so its cursor must read `NULL`.
   *
   * TX-COMPOSABLE (`exec`): the arm runs INSIDE the engine's Phase-1 advisory-locked txn, so the
   * marker and its correlation can never diverge and a concurrent evaluation serialized behind
   * the lock sees both. `updated_at` bumps via the column's `$onUpdateFn`.
   */
  async armPendingTopup(
    input: { walletId: string; at: Date; triggeringEntryId: string },
    exec: DbExecutor = db
  ): Promise<void> {
    await exec
      .update(creditWallets)
      .set({
        pendingTopupAt: input.at,
        pendingTopupTriggeringEntryId: input.triggeringEntryId,
        pendingTopupPaymentIntentId: null,
        // BAL-521 — a fresh crossing has never alarmed. See the docblock: inheriting a stale
        // stamp de-prioritises a live reload.
        pendingTopupAlarmedAt: null,
      })
      .where(eq(creditWallets.id, input.walletId));
  },

  /**
   * BAL-515 — stamp the in-flight PaymentIntent id on a marker, GUARDED on the crossing it
   * belongs to. Called immediately after the phase-2 charge returns `processing` (the id does
   * not exist before then).
   *
   * Returns `false`, having written nothing, when the marker moved on between the arm and the
   * stamp — cleared by a webhook that already landed, or re-armed for a DIFFERENT crossing. The
   * `WHERE` carries `pending_topup_triggering_entry_id = triggeringEntryId` precisely so a
   * later crossing's marker is never mislabelled with this crossing's PaymentIntent, which would
   * aim the reconcile at the wrong charge. A `false` is not an error: the reconcile can still
   * recover the PaymentIntent from Stripe by idempotency key.
   */
  async recordPendingTopupPaymentIntent(
    input: { walletId: string; triggeringEntryId: string; paymentIntentId: string },
    exec: DbExecutor = db
  ): Promise<boolean> {
    const rows = await exec
      .update(creditWallets)
      .set({ pendingTopupPaymentIntentId: input.paymentIntentId })
      .where(
        and(
          eq(creditWallets.id, input.walletId),
          eq(creditWallets.pendingTopupTriggeringEntryId, input.triggeringEntryId)
        )
      )
      .returning({ id: creditWallets.id });
    return rows.length > 0;
  },

  /**
   * BAL-515 — CLEAR the auto-top-up marker and its correlation TOGETHER (replaces
   * `setPendingTopupAt(walletId, null)` at every clear site: the success/fail webhook arms, a
   * definite sync failure, and the reconcile's own resolutions).
   *
   * All three columns null in one statement, so a cleared marker can never leave a stale entry
   * id or PaymentIntent id behind for the next crossing's reconcile to trip over.
   *
   * ⚠ BAL-521 (AMEND-9) — `pending_topup_alarmed_at` NULLS WITH THEM, in that same statement. A
   * drained marker has nothing left to be alarmed about, and this wallet is no longer a finder
   * candidate at all, so leaving the stamp would make the rotation cursor describe a crossing
   * that no longer exists. It also means the next crossing starts from `NULL` (the head of the
   * batch) even if it arms through a path that somehow bypassed `armPendingTopup`.
   *
   * ⚠ PASS `triggeringEntryId` UNLESS THE CALLER PROVABLY OWNS THE CURRENT MARKER. With it the
   * `WHERE` carries `pending_topup_triggering_entry_id = triggeringEntryId` — the same predicate
   * `recordPendingTopupPaymentIntent` already carries — so a clear whose crossing has been
   * superseded writes NOTHING and returns `false`. Without it, a caller acting on a STALE read
   * (the reconcile sweep loads up to 100 wallets and then spends seconds of Stripe latency per
   * row; a Stripe webhook can be redelivered for ~3 days) can clear a marker that was re-armed
   * for a DIFFERENT, LIVE crossing in between — erasing the only evidence that crossing's
   * reconcile has to work from. The one legitimate unguarded caller is the SYNC engine
   * (`evaluateAutoTopup`), which armed the very marker it is clearing one Stripe round-trip
   * earlier, far inside `TOPUP_IN_FLIGHT_TTL_MS`.
   *
   * ⚠ WHAT PREVENTS A SECOND CHARGE IS THE BALANCE GUARD, NOT THE LEDGER UNIQUE — correcting a
   * claim that stood here. The ledger `idempotency_key` is PER CROSSING
   * (`auto_topup:{walletId}:{triggeringEntryId}`), so wiping a live crossing's marker lets the
   * next evaluation pin a NEW `triggeringEntryId` and therefore a DIFFERENT key: the unique index
   * sees no conflict and cannot stop the second charge. The real guarantee is
   * `evaluateAutoTopup`'s threshold test (`balanceMinor >= topupThresholdMinor` ⇒ skip
   * `above_threshold`) once the first reload's credit has landed — which is exactly why erasing
   * the evidence that GETS that credit landed is the dangerous part. Same mis-attribution
   * `end-session.ts`'s `markSettledFromReconcile` had to correct once.
   *
   * Returns whether a row was actually cleared, so a guarded caller can log a no-op clear rather
   * than assume it landed.
   */
  async clearPendingTopup(
    input: { walletId: string; triggeringEntryId?: string },
    exec: DbExecutor = db
  ): Promise<boolean> {
    const { triggeringEntryId } = input;
    const rows = await exec
      .update(creditWallets)
      .set({
        pendingTopupAt: null,
        pendingTopupTriggeringEntryId: null,
        pendingTopupPaymentIntentId: null,
        // BAL-521 — the rotation cursor drains with the marker it describes.
        pendingTopupAlarmedAt: null,
      })
      .where(
        triggeringEntryId === undefined
          ? eq(creditWallets.id, input.walletId)
          : and(
              eq(creditWallets.id, input.walletId),
              eq(creditWallets.pendingTopupTriggeringEntryId, triggeringEntryId)
            )
      )
      .returning({ id: creditWallets.id });
    return rows.length > 0;
  },

  /**
   * BAL-515 — the auto-top-up reconcile finder: wallets whose in-flight marker has stood since
   * at or before `cutoff` (`now − TOPUP_RECONCILE_AFTER_MS` at the caller).
   *
   * `pending_topup_triggering_entry_id IS NOT NULL` is a REQUIRED arm, not belt-and-braces: a
   * marker with no correlation cannot be reconciled (its ledger key is underivable), so
   * returning it would hand the sweep a row it can only skip. Any such row is a pre-BAL-515
   * leftover and self-heals at `TOPUP_IN_FLIGHT_TTL_MS`.
   *
   * ⚠ BAL-521 §2 (AMEND-7) — THE ORDER IS NO LONGER "OLDEST FIRST". It is a two-key ROTATION:
   * `pending_topup_alarmed_at ASC NULLS FIRST, pending_topup_at ASC`. Never-alarmed rows (NULL
   * cursor) always lead the batch; alarmed rows follow, least-recently-alarmed first. An alarming
   * row writes nothing and clears nothing by design, so under the old single-key `pending_topup_at
   * ASC` a permanently-alarmed row owned the head of a `LIMIT`-ed batch forever and starved every
   * newer stuck reload — silently. Rotation makes a fresh row unstarvable BEHIND ALARMED ROWS (its
   * NULL cursor always sorts ahead of any stamped one) AND covers the whole alarmed set across
   * consecutive ticks instead of re-checking one slice of it. Alarmed rows are DE-PRIORITISED,
   * never excluded: exclusion would foreclose the `partial_refund` self-heal, whose terminal
   * `refunded` arm only fires while this finder still returns the row.
   *
   * ⚠ NAMED RESIDUAL — "unstarvable" does NOT extend to ordering WITHIN the NULL group itself. An
   * escalated `still_in_flight` row (BAL-521 §1) is `deferred`, never `alarm`, so D6 forbids
   * stamping it — its cursor stays permanently NULL, in the SAME group as genuinely fresh rows,
   * and (being old) sorts AHEAD of a fresh row there by the `pending_topup_at ASC` tie-break. A
   * long-stuck-but-still-processing PaymentIntent can therefore occupy a batch slot a fresh row
   * would otherwise get. Accepted: it is still `deferred` (writes nothing, strands no money), it
   * is reported once per tick via the escalated-set record, and D6's ban on stamping it is
   * unchanged by this note — do NOT stamp it to "fix" this.
   *
   * `NULLS FIRST` is written EXPLICITLY because Postgres' default for `ASC` is `NULLS LAST`, which
   * would put every never-alarmed row at the BACK and make the starvation strictly worse than it
   * was. Drizzle's `asc()` cannot express nulls ordering, hence the `sql` fragment for that key
   * only (no bound values in the template).
   *
   * ⚠ THE INDEX SERVES THE PREDICATE, NOT THE ORDERING — correcting a claim that stood here.
   * `credit_wallets_pending_topup_idx` (partial on `pending_topup_at IS NOT NULL`) still matches
   * this `WHERE` exactly, but the sort's LEADING key is not in it, so Postgres scans and then
   * SORTS. Accepted deliberately: the partial index restricts the sort input to wallets with a
   * reload ACTUALLY IN FLIGHT — a tiny fraction of a table that is already one row per company —
   * while the sweep spends seconds of Stripe latency per returned row. A composite index would
   * serve the ordering, but it is a new index on the money path bought against no measured
   * problem. See the index's own note in `schema/credit-wallets.ts`.
   *
   * BOUNDED by `limit` — the caller MUST warn when the batch fills (no silent caps). Returns FULL
   * rows: the reconcile needs the customer id, the correlation columns and the mandate status.
   * `credit_wallets` has no `deleted_at`, so there is no soft-delete filter.
   */
  async findStuckPendingTopups(cutoff: Date, limit: number): Promise<CreditWallet[]> {
    return db
      .select()
      .from(creditWallets)
      .where(stuckPendingTopupWhere(cutoff))
      .orderBy(
        sql`${creditWallets.pendingTopupAlarmedAt} asc nulls first`,
        asc(creditWallets.pendingTopupAt)
      )
      .limit(limit);
  },

  /**
   * BAL-521 §2 — stamp the rotation cursor on the wallets that ALARMED on this tick, in ONE
   * statement for the whole tick (never one per row). The sweep calls it once, after its reconcile
   * loop, off the `alarmed` array it already builds.
   *
   * ⚠ GUARDED ON THE CROSSING — `(walletId, triggeringEntryId)` pair equality, never a bare
   * `id IN (…)`. The sweep reads up to 100 wallets and then spends seconds of Stripe latency PER
   * ROW before it stamps; in that window a marker can be cleared, or re-armed for a DIFFERENT,
   * LIVE crossing (the same window `clearPendingTopup`'s docblock warns about). An unguarded stamp
   * would de-prioritise a FRESH, in-flight reload — the identical money hazard the `armPendingTopup`
   * un-alarm closes, arriving by a second route. Pair equality makes that unreachable: a superseded
   * row simply does not match, and is not stamped.
   *
   * ⚠ NEVER CALL THIS WITH AN ESCALATED `still_in_flight` ROW. That row is `deferred`, not
   * `alarm`: its PaymentIntent is still `processing` and can still settle, so de-prioritising it
   * would strand real money. The sweep keeps the two arrays disjoint by construction.
   *
   * An EMPTY `rows` returns `0` having issued NO statement — `or()` over an empty list is
   * `undefined`, and `.where(undefined)` is no predicate at all, i.e. it would stamp every wallet
   * in the table. The predicate is therefore built first and refused when absent.
   *
   * Returns the number of rows ACTUALLY stamped, so the caller can warn on a shortfall (some
   * markers moved on between the read and the stamp) rather than assume it landed — the same
   * posture as `clearPendingTopup`'s boolean return. `exec` defaults to the base `db`: the sweep
   * holds no transaction. Tx-composable for symmetry with every sibling.
   */
  async markPendingTopupAlarmed(
    rows: ReadonlyArray<{ walletId: string; triggeringEntryId: string }>,
    at: Date,
    exec: DbExecutor = db
  ): Promise<number> {
    const crossings = or(
      ...rows.map((row) =>
        and(
          eq(creditWallets.id, row.walletId),
          eq(creditWallets.pendingTopupTriggeringEntryId, row.triggeringEntryId)
        )
      )
    );
    // Empty batch ⇒ no predicate ⇒ NO STATEMENT. See the docblock: a bare `.set()` would stamp
    // every wallet in the table.
    if (crossings === undefined) {
      return 0;
    }

    const stamped = await exec
      .update(creditWallets)
      .set({ pendingTopupAlarmedAt: at })
      .where(crossings)
      .returning({ id: creditWallets.id });
    return stamped.length;
  },

  /**
   * BAL-521 §2 — how many stuck-and-ALARMED wallets stand past `cutoff`, in total.
   *
   * ⚠ NOT DERIVABLE FROM WHAT A TICK REPORTS. Alarmed rows are de-prioritised and rotate, so one
   * tick only ever reaches a SLICE of the alarmed backlog; without this figure a filled batch of
   * 100 is indistinguishable from a backlog of 10,000, which is precisely the silent cap §2 exists
   * to remove. Emitted on every escalation record beside the slice the tick did reach.
   *
   * Shares `stuckPendingTopupWhere` with `findStuckPendingTopups` — same three arms, so the two can
   * never describe different row sets — plus `pending_topup_alarmed_at IS NOT NULL`. Counts BOTH
   * alarm reasons: the column records that a row alarmed, not why. Standalone read on the base
   * `db`, like `findExpirableWallets`.
   */
  async countAlarmedPendingTopups(cutoff: Date): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(creditWallets)
      .where(and(stuckPendingTopupWhere(cutoff), isNotNull(creditWallets.pendingTopupAlarmedAt)));
    // `count(*)` always yields exactly one row; the fallback satisfies `noUncheckedIndexedAccess`.
    return row?.count ?? 0;
  },

  /**
   * BAL-515 — wallets holding a given Stripe payment method. The `payment_method.*` webhook arms'
   * only way from a Stripe payload back to a wallet.
   *
   * ⚠ RETURNS AN ARRAY, and `credit_wallets_stripe_payment_method_idx` is NON-unique. No
   * constraint forbids two wallets naming one payment method, so a UNIQUE index would have
   * aborted migration 0081 on any pre-existing duplicate — a hazard the empty-database
   * Testcontainers harness cannot surface. The repository therefore reports the ambiguity
   * instead of resolving it, and the caller refuses to act on a card event it cannot attribute.
   * `.limit(2)` — one extra row is all it takes to detect ambiguity.
   */
  async listByStripePaymentMethodId(
    paymentMethodId: string,
    exec: DbExecutor = db
  ): Promise<CreditWallet[]> {
    return exec
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.stripePaymentMethodId, paymentMethodId))
      .limit(2);
  },

  /** The one wallet for a company (rides `credit_wallets_company_idx`). */
  async findByCompanyId(companyId: string): Promise<CreditWallet | undefined> {
    return db.query.creditWallets.findFirst({
      where: eq(creditWallets.companyId, companyId),
    });
  },

  /**
   * Wallets whose rolling dormancy expiry has been reached and still hold a positive
   * balance — the eligibility set for the daily expiry sweep (BAL-380). Filters
   * `expires_at IS NOT NULL AND expires_at <= now AND balance_minor > 0`, oldest expiry
   * first. Returns FULL rows (server-side job use only — the sweep needs `id`,
   * `companyId`, `balanceMinor`, `expiresAt`). Each returned wallet is then re-read under
   * the advisory lock in `expireDormantBalance` before any write (the top-up race guard).
   * `credit_wallets` has NO `deleted_at`, so there is no soft-delete filter.
   */
  async findExpirableWallets(now: Date): Promise<CreditWallet[]> {
    return db
      .select()
      .from(creditWallets)
      .where(
        and(
          isNotNull(creditWallets.expiresAt),
          lte(creditWallets.expiresAt, now),
          gt(creditWallets.balanceMinor, 0)
        )
      )
      .orderBy(asc(creditWallets.expiresAt));
  },

  /**
   * Wallets whose rolling dormancy expiry falls in the half-open band `(after, until]`
   * and still hold a positive balance — the pre-expiry reminder set for the daily sweep
   * (BAL-380). The 60d/30d reminder bands map to `(now+59d, now+60d]` / `(now+29d, now+30d]`;
   * the half-open interval (strictly `> after`, `<= until`) makes adjacent daily bands
   * partition cleanly so a wallet crosses each band on exactly one tick. `NULL` expiries
   * are excluded by construction (`NULL > after` is unknown). Oldest expiry first.
   */
  async findWalletsExpiringBetween(after: Date, until: Date): Promise<CreditWallet[]> {
    return db
      .select()
      .from(creditWallets)
      .where(
        and(
          gt(creditWallets.expiresAt, after),
          lte(creditWallets.expiresAt, until),
          gt(creditWallets.balanceMinor, 0)
        )
      )
      .orderBy(asc(creditWallets.expiresAt));
  },

  /**
   * Write wallet config (the data plane for the later MANAGE_BILLING-gated actions —
   * NO gating here, the caller resolves the capability). Only the provided fields are
   * written; `overdraftCeilingMinor`/`stripePaymentMethodId`/`mandateRef` accept an
   * explicit `null` to clear. Throws if the wallet is missing.
   */
  async updateConfig(id: string, input: UpdateWalletConfigInput): Promise<CreditWallet> {
    const set: Partial<NewCreditWallet> = {};
    if (input.lowBalanceMode !== undefined) set.lowBalanceMode = input.lowBalanceMode;
    if (input.topupThresholdMinor !== undefined)
      set.topupThresholdMinor = input.topupThresholdMinor;
    if (input.topupReloadMinor !== undefined) set.topupReloadMinor = input.topupReloadMinor;
    if (input.overdraftCeilingMinor !== undefined)
      set.overdraftCeilingMinor = input.overdraftCeilingMinor;
    if (input.stripePaymentMethodId !== undefined)
      set.stripePaymentMethodId = input.stripePaymentMethodId;
    if (input.mandateRef !== undefined) set.mandateRef = input.mandateRef;

    // Nothing to write → return the current row (a bare `.set({})` would error).
    if (Object.keys(set).length === 0) {
      const current = await db.query.creditWallets.findFirst({ where: eq(creditWallets.id, id) });
      if (current === undefined) {
        throw new Error(`Credit wallet not found: ${id}`);
      }
      return current;
    }

    const [row] = await db
      .update(creditWallets)
      .set(set)
      .where(eq(creditWallets.id, id))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${id}`);
    }
    return row;
  },

  /**
   * Persist an ACTIVE off-session mandate on the wallet (BAL-382) — customer +
   * payment-method + mandate ref + `mandate_status='active'`, in ONE write. Tx-composable
   * via `DbExecutor` (pass the webhook's `tx` so it commits with the marker + effect;
   * mirrors `auditEventsRepository.record`). Written on `setup_intent.succeeded`. Throws
   * if the wallet is missing.
   *
   * When `card` is supplied the four DISPLAY columns land in the SAME `UPDATE` as the mandate
   * columns — one statement, so the all-or-none CHECK can never see a half-written row. When it
   * is absent (Stripe could not be read — `retrieveCardDisplay` fails soft) the display columns
   * are left exactly as they were: a card read failure must never blank a card the buyer can
   * still see.
   *
   * BAL-515: `card_updated_at` is stamped ONLY inside the optional `card` branch, for exactly
   * that reason — a card-less mandate write must leave the display columns AND their provenance
   * untouched, or a wallet would claim its displayed card was refreshed when nothing read it.
   */
  async applyMandate(
    exec: DbExecutor,
    input: {
      walletId: string;
      stripeCustomerId: string;
      stripePaymentMethodId: string;
      mandateRef: string;
      mandateStatus: 'active';
      /** Display facts of the just-confirmed card. Absent when Stripe could not be read. */
      card?: CardDisplayInput;
    }
  ): Promise<CreditWallet> {
    const [row] = await exec
      .update(creditWallets)
      .set({
        stripeCustomerId: input.stripeCustomerId,
        stripePaymentMethodId: input.stripePaymentMethodId,
        mandateRef: input.mandateRef,
        mandateStatus: input.mandateStatus,
        // DB `now()` (transaction time, no app↔DB clock skew), and only when a card is written.
        ...(input.card === undefined ? {} : { ...input.card, cardUpdatedAt: sql`now()` }),
      })
      .where(eq(creditWallets.id, input.walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${input.walletId}`);
    }
    return row;
  },

  /**
   * Persist the customer + payment-method id + card DISPLAY facts. Called from
   * `payment_intent.succeeded` for a `manual_purchase`, so a `notify_only` buyer (who never
   * opens a SetupIntent) still sees their card next time.
   *
   * ⚠ THIS NEVER ACTIVATES A MANDATE, AND IT REVOKES ONE WHOSE CARD HAS CHANGED. Two rules,
   * one statement:
   *
   *  1. `mandate_status` is never set to `'active'` here. Every off-session charge gates on
   *     `isWalletMandateActive`, so persisting a payment-method id enables ON-SESSION reuse only
   *     (the buyer is present and pressing Pay), never an unattended auto-top-up or overdraft
   *     settlement.
   *  2. When the incoming payment method DIFFERS from the stored one, `mandate_status` and
   *     `mandate_ref` are both cleared to NULL. Without this, moving the id out from under a
   *     still-`'active'` status would silently re-point a live off-session mandate at a card
   *     that never went through a SetupIntent — `isWalletMandateActive` is a conjunction over
   *     three columns, and rule 1 only guards one of them. Clearing the status makes the next
   *     card-backed purchase re-open a SetupIntent (the web action short-circuits only on
   *     `'active'`), so consent is re-captured against the card actually on file. The invariant
   *     this buys: THE MANDATE COLUMNS ALWAYS DESCRIBE THE CARD THEY WERE CAPTURED AGAINST.
   *
   * ⚠ ONE STATEMENT, DELIBERATELY. Read-then-write would be a race on the money path (two
   * concurrent webhooks could each read the old id and neither revoke), so the comparison is a
   * SQL `CASE` over the row's own pre-UPDATE value. `IS DISTINCT FROM` rather than `<>` so a
   * wallet with no card yet (`NULL`) compares as "changed" instead of yielding NULL.
   *
   * Do not "simplify" this by folding it into `applyMandate`; the two are a consent boundary,
   * not a duplication (see `isWalletCardReusableOnSession` in `@balo/shared/credit`).
   *
   * Tx-composable; last-writer-wins. Throws if the wallet is missing.
   */
  async applySavedCardDisplay(
    exec: DbExecutor,
    input: {
      walletId: string;
      stripeCustomerId: string;
      stripePaymentMethodId: string;
      card: CardDisplayInput;
    }
  ): Promise<CreditWallet> {
    // Evaluated against the PRE-UPDATE row (Postgres reads SET expressions from the old tuple),
    // so this compares the card on file with the card just charged.
    const cardChanged = sql`${creditWallets.stripePaymentMethodId} IS DISTINCT FROM ${input.stripePaymentMethodId}`;
    const [row] = await exec
      .update(creditWallets)
      .set({
        stripeCustomerId: input.stripeCustomerId,
        stripePaymentMethodId: input.stripePaymentMethodId,
        mandateStatus: sql`CASE WHEN ${cardChanged} THEN NULL ELSE ${creditWallets.mandateStatus} END`,
        mandateRef: sql`CASE WHEN ${cardChanged} THEN NULL ELSE ${creditWallets.mandateRef} END`,
        ...input.card,
        // BAL-515 — provenance of the four display columns above, unconditional here because
        // this method ALWAYS writes them. DB `now()` = transaction time, no app↔DB clock skew.
        cardUpdatedAt: sql`now()`,
      })
      .where(eq(creditWallets.id, input.walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${input.walletId}`);
    }
    return row;
  },

  /**
   * BAL-515 — refresh the four card DISPLAY columns and their `card_updated_at` provenance, and
   * NOTHING ELSE. Written from the `payment_method.automatically_updated` webhook arm, where the
   * card network reissued the card behind the same payment method (new digits, new expiry) and
   * nothing in Balo would otherwise ever learn about it.
   *
   * ⚠ DELIBERATELY NARROWER THAN `applySavedCardDisplay`. That method is a CONSENT boundary: it
   * writes `stripe_payment_method_id` and REVOKES the mandate whenever the card underneath it
   * changes. A network-initiated update carries the SAME payment-method id by definition, so
   * there is no consent event to record here — only new digits to show. Routing this through the
   * consent path would put a mandate-revoke branch on a pure display refresh, where it could only
   * ever be a bug: an issuer reissuing a card must not silently disable the buyer's auto-top-up.
   *
   * The four columns move together (the `credit_wallets_card_display_all_or_none` CHECK), which
   * is why the input is one object and not four optional fields. Tx-composable; throws if the
   * wallet is missing.
   */
  async refreshSavedCardDisplay(
    exec: DbExecutor,
    input: { walletId: string; card: CardDisplayInput }
  ): Promise<CreditWallet> {
    const [row] = await exec
      .update(creditWallets)
      .set({ ...input.card, cardUpdatedAt: sql`now()` })
      .where(eq(creditWallets.id, input.walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${input.walletId}`);
    }
    return row;
  },

  /**
   * BAL-515 — the card is GONE at Stripe (`payment_method.detached`). Clears the four display
   * columns TOGETHER (landing on the all-NULL arm of `credit_wallets_card_display_all_or_none`),
   * the payment-method id, and both mandate columns — one statement, so the CHECK can never see a
   * half-written row.
   *
   * ⚠ THE MANDATE CLEAR IS FAIL-CLOSED AND REQUIRED, not tidiness. A detached payment method
   * cannot be charged; leaving `mandate_status = 'active'` would let auto-top-up and overdraft
   * settlement keep firing off-session charges at a dead card, each failing after the money
   * decision had already been taken. Clearing the status makes the next card-backed purchase
   * re-open a SetupIntent, so consent is re-captured against a card that actually exists.
   *
   * ⚠ `stripe_customer_id` SURVIVES, deliberately. The Stripe customer outlives a payment-method
   * detach; blanking it would make `ensureCustomer` mint a duplicate customer for the same
   * company and scatter that company's payment history across two Stripe records.
   *
   * `card_updated_at` is stamped (not nulled): "we learned at this time that there is no card" is
   * provenance too, and the column's contract is "when the display facts were last established".
   */
  async clearSavedCard(exec: DbExecutor, walletId: string): Promise<CreditWallet> {
    const [row] = await exec
      .update(creditWallets)
      .set({
        cardBrand: null,
        cardLast4: null,
        cardExpMonth: null,
        cardExpYear: null,
        cardUpdatedAt: sql`now()`,
        stripePaymentMethodId: null,
        mandateRef: null,
        mandateStatus: null,
      })
      .where(eq(creditWallets.id, walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${walletId}`);
    }
    return row;
  },

  /**
   * BAL-516 / BAL-521 — card removal BY EITHER DOOR: `clearSavedCard` PLUS the low-balance-mode
   * reconcile PLUS one audit row. `source` says which door; nothing else about the behaviour
   * differs between them, which is the point of having ONE primitive.
   *
   * ⚠ TWO STATEMENTS, NOT SELF-TRANSACTING — THE CALLER MUST PASS A TRANSACTION `exec`. This is
   * the atomicity guarantee the whole removal flow rests on: between the clear and the reconcile
   * the wallet holds no card but still names a CARD-BACKED low-balance mode, and no reader may
   * ever observe that state. Card-gone/mode-still-armed is what makes auto-top-up and overdraft
   * settlement fire off-session charges at a card that no longer exists.
   *
   * Goes THROUGH `clearSavedCard` — the fail-closed clear is never restated here. That method
   * owns the rule that the four display columns, `stripe_payment_method_id` and BOTH mandate
   * columns move in ONE statement (the `credit_wallets_card_display_all_or_none` CHECK can never
   * see a half-written row), and that `stripe_customer_id` deliberately SURVIVES the detach.
   *
   * The reconcile: iff the cleared row's `low_balance_mode` is card-backed (`auto_topup` /
   * `keep_going`) it moves to `notify_only` and `modeReconciled` is `true`. A wallet already on
   * `notify_only` is returned untouched (`false`) — there is nothing armed to disarm.
   *
   * ⚠ `topup_reload_minor` / `topup_threshold_minor` ARE NOT TOUCHED, deliberately. Removing a
   * card says nothing about how much the client wants reloaded; keeping their chosen band means
   * adding a card and re-enabling auto top-up later RESTORES it, instead of silently resetting to
   * the schema defaults.
   *
   * Idempotent by construction: a repeat call re-nulls nulls and then finds a non-card-backed
   * mode, so it returns the same row with `modeReconciled: false`. Throws if the wallet is
   * missing (from `clearSavedCard`).
   *
   * FIX ROUND 3 (N2) — also appends ONE `audit_events` row, through the SAME `exec`, so the row
   * and the change it records commit or roll back together (`auditEventsRepository.record`
   * takes an executor for exactly this). `metadata` carries `source` + `modeReconciled` + the
   * resulting effective `lowBalanceMode` only: NO card facts, NO `mandateRef`, NO Stripe ids (not
   * even the Stripe EVENT id the webhook door holds) — those never belong in an audit trail, and
   * the `actor` parameter is deliberately narrow enough that this arm has no way to pass one. If
   * the insert throws, it propagates like any other statement on this `exec`, so the caller's
   * transaction rolls back the clear along with it (fail-closed).
   *
   * ⚠ ACTION NAME AND `metadata.source` ARE A SHARED SCHEME, not local choices. The repo's
   * convention is `<entityType>.<verb>` — see the sibling `credit_wallet.dispute_opened` — so
   * this is `credit_wallet.saved_card_detached`, NOT `saved_card.detached`. A saved card can be
   * detached two ways, and AS OF BAL-521 BOTH ARE WIRED THROUGH HERE:
   *   · `user_initiated` — a client pressing Remove (`detachSavedCard`, `services/stripe/mandate.ts`)
   *   · `stripe_webhook` — Stripe's inbound `payment_method.detached` (the bank, the card provider
   *     or a Dashboard action), whose applier passes `actorUserId: null`
   * Both land on the SAME action with `metadata.source` telling them apart, so one query answers
   * "how did this wallet lose its card?". DO NOT fork the action name to encode the door; that is
   * what `source` is for, and it is why the parameter is `{ actorUserId, source }` rather than two
   * near-identical methods.
   *
   * ⚠ `actorUserId: null` IS THE SYSTEM ACTOR, not a missing value. It is the repo's shipped
   * convention (`RecordAuditInput.actorUserId: string | null`; the sibling `dispute` arm already
   * inserts `null`) — no sentinel user row, no migration. The webhook door genuinely has no human
   * actor: Stripe did this. Either way the actor is the CALLER'S already-resolved one; this
   * function never derives an actor itself.
   *
   * ⚠ TWO AUDIT ROWS FOR ONE PHYSICAL DETACH IS CORRECT, not a bug to fix. If the webhook commits
   * first, the user door then re-nulls nulls, finds a non-card-backed mode, and writes its own
   * `user_initiated` row. Both statements are true: Stripe detached the card, AND a member pressed
   * Remove. Idempotence here is about the WALLET STATE, never about suppressing a record.
   *
   * Returns, beyond the row and the flag:
   *   · `auditEventId` — the id `auditEventsRepository.record` already returns and this primitive
   *     used to discard. The user door's notification correlationId is built from it, so it must
   *     be surfaced; it is also the stable trace key between the audit trail and the notice.
   *   · `previousLowBalanceMode` — the mode BEFORE the reconcile, which the returned `wallet`
   *     can no longer tell you (it is always `notify_only` once reconciled) and which the copy
   *     needs to name WHICH card-backed mode went off. Safe to read off `cleared`: `clearSavedCard`
   *     provably does not write `low_balance_mode` — its single `.set()` names eight columns and
   *     the mode is not among them — so the cleared row still carries the pre-reconcile value.
   */
  async clearSavedCardAndReconcileMode(
    exec: DbExecutor,
    walletId: string,
    actor: { actorUserId: string | null; source: SavedCardDetachSource }
  ): Promise<{
    wallet: CreditWallet;
    modeReconciled: boolean;
    auditEventId: string;
    previousLowBalanceMode: CreditWallet['lowBalanceMode'];
  }> {
    const cleared = await creditWalletsRepository.clearSavedCard(exec, walletId);
    // The pre-reconcile mode. See the docblock: `clearSavedCard` never writes `low_balance_mode`,
    // so this IS the value the wallet held before this call.
    const previousLowBalanceMode = cleared.lowBalanceMode;

    let wallet = cleared;
    let modeReconciled = false;
    if (cleared.lowBalanceMode === 'auto_topup' || cleared.lowBalanceMode === 'keep_going') {
      const [reconciled] = await exec
        .update(creditWallets)
        .set({ lowBalanceMode: 'notify_only' })
        .where(eq(creditWallets.id, walletId))
        .returning();
      if (reconciled === undefined) {
        throw new Error(`Credit wallet not found: ${walletId}`);
      }
      wallet = reconciled;
      modeReconciled = true;
    }

    const auditEvent = await auditEventsRepository.record(
      {
        actorUserId: actor.actorUserId,
        action: 'credit_wallet.saved_card_detached',
        entityType: 'credit_wallet',
        entityId: walletId,
        metadata: {
          source: actor.source,
          modeReconciled,
          // The EFFECTIVE (post-reconcile) mode — the shipped scheme, unchanged by BAL-521.
          // `previousLowBalanceMode` is returned to the caller, never written here.
          lowBalanceMode: wallet.lowBalanceMode,
        },
      },
      exec
    );

    return { wallet, modeReconciled, auditEventId: auditEvent.id, previousLowBalanceMode };
  },

  /**
   * Flip only the mandate lifecycle status (BAL-382) — e.g. `pending` on
   * `createSetupIntent`, `failed` on `setup_intent.setup_failed`. Tx-composable via
   * `DbExecutor`. Does NOT touch the customer / payment-method / mandate-ref columns, nor the
   * card display columns.
   * Throws if the wallet is missing.
   */
  async applyMandateStatus(
    exec: DbExecutor,
    walletId: string,
    status: MandateStatus
  ): Promise<CreditWallet> {
    // ⚠ `active` → `pending` IS REFUSED. `pending` means "an attempt is in flight"; `active`
    // means "a mandate is established". Writing the former over the latter loses information
    // and silently disables every off-session path, because `isWalletMandateActive` is a
    // conjunction including the status — auto-top-up and overdraft settlement simply stop
    // firing, with nothing to retry them.
    //
    // The race that makes this reachable: `confirmSavedCardMandate` calls
    // `setupIntents.create({ confirm: true })`, which can reach `succeeded` DURING the call, so
    // Stripe queues `setup_intent.succeeded` before it returns. That webhook writes `active`
    // via `applyMandate`. If it wins, the caller's subsequent `pending` write would strand the
    // wallet at `pending` permanently. (`createSetupIntent` does NOT confirm, so its intent
    // cannot succeed until the user acts — that gap is what makes writing `pending` safe there,
    // and it is exactly what `confirm: true` removes.)
    //
    // Refusing is fail-SAFE in both directions: a genuine re-capture on an already-active
    // wallet still completes and re-writes `active`, it just never dips through a window where
    // charging is disabled. A card CHANGE is a different transition — `applySavedCardDisplay`
    // nulls the status first, so this guard cannot block re-capture after one.
    //
    // `active` → `failed` is untouched: a mandate that genuinely fails later MUST be recorded.
    // One statement, so no read-then-write race on the money path.
    const nextStatus =
      status === 'pending'
        ? sql`CASE WHEN ${creditWallets.mandateStatus} = 'active' THEN ${creditWallets.mandateStatus} ELSE ${status}::mandate_status END`
        : sql`${status}::mandate_status`;
    const [row] = await exec
      .update(creditWallets)
      .set({ mandateStatus: nextStatus })
      .where(eq(creditWallets.id, walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${walletId}`);
    }
    return row;
  },
};
