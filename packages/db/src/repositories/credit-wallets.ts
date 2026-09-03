import { and, asc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  creditWallets,
  type CreditWallet,
  type MandateStatus,
  type NewCreditWallet,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

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
   * at or before `cutoff` (`now − TOPUP_RECONCILE_AFTER_MS` at the caller), oldest first.
   *
   * `pending_topup_triggering_entry_id IS NOT NULL` is a REQUIRED arm, not belt-and-braces: a
   * marker with no correlation cannot be reconciled (its ledger key is underivable), so
   * returning it would hand the sweep a row it can only skip. Any such row is a pre-BAL-515
   * leftover and self-heals at `TOPUP_IN_FLIGHT_TTL_MS`.
   *
   * BOUNDED by `limit` — the caller MUST warn when the batch fills (no silent caps). Rides
   * `credit_wallets_pending_topup_idx` (partial on `pending_topup_at IS NOT NULL`). Returns FULL
   * rows: the reconcile needs the customer id, the correlation columns and the mandate status.
   * `credit_wallets` has no `deleted_at`, so there is no soft-delete filter.
   */
  async findStuckPendingTopups(cutoff: Date, limit: number): Promise<CreditWallet[]> {
    return db
      .select()
      .from(creditWallets)
      .where(
        and(
          isNotNull(creditWallets.pendingTopupAt),
          lte(creditWallets.pendingTopupAt, cutoff),
          isNotNull(creditWallets.pendingTopupTriggeringEntryId)
        )
      )
      .orderBy(asc(creditWallets.pendingTopupAt))
      .limit(limit);
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
