/**
 * BAL-535 (ADR-1040 Amendment 6 §F, fix round B1) — THE ONE PLACE that decides whether a
 * company's own cash covers its outstanding debt. All THREE sites that can release a soft
 * account hold call this and nothing else:
 *
 *   · R3  — `clearReceivablesCoveredByCredit` (`apps/api/src/services/stripe/dispatch.ts`), the
 *           covering-credit exit itself.
 *   · R3b — `openReceivableAndDun` (`apps/api/src/services/credit-session/end-session.ts`) and
 *           `handleOverdraftChargeFailed` (`dispatch.ts`), the two late-open self-clears.
 *
 * ⚠⚠ WHY IT EXISTS AS A FUNCTION RATHER THAN THREE INLINE PREDICATE CALLS. Amendment 6 §F
 * claimed the promo exclusion was "structural rather than conditional" on the strength of ONE
 * site's local ordering (R3 read the balance upstream of the bundled promo grant). That
 * argument never reached a promo granted in an EARLIER transaction — already inside the
 * aggregate `balance_minor`, so a one-cent cash top-up discharged the whole receivable — and it
 * never reached the two R3b sites at all, which read COMMITTED wallet state and therefore saw
 * every promo adjustment ever made. Adjacency to a promo grant is not a gate. This is.
 *
 * **The rule, stated once.** Take the wallet's LIVE balance (never the receivable's stale
 * `amount_minor`), subtract every promo grant that landed since the oldest still-open debt
 * became outstanding, and ask whether what remains is non-negative. Marketing money is thereby
 * unable to discharge a real receivable no matter which transaction it arrived in.
 *
 * **The anchor is the debt's moment, not the row's.** `earliestOpenDebtAnchor` resolves
 * `MIN(COALESCE(session.ended_at, receivable.opened_at))`. On the R3b paths the receivable row
 * is inserted in the very transaction that then asks this question, so anchoring on its
 * `opened_at` would give a zero-width window and a zero discount — the vacuous gate B1 removes.
 * `ended_at` is when the terminal overdraft was actually computed, which is what "the debt
 * became outstanding" means on every path.
 *
 * ⚠ READ IT UNDER THE WALLET LOCK. Every caller holds the wallet's `pg_advisory_xact_lock`
 * before asking (R3 via `applyLedgerEntry`; both R3b sites via an explicit `acquireWalletLock`
 * — see M2), so the balance, the open-receivable set and the promo sum are one consistent
 * snapshot that no concurrent credit can tear.
 */
import {
  auditEventsRepository,
  creditLedgerRepository,
  creditReceivablesRepository,
  db,
} from '@balo/db';
import { creditCoversOutstandingDebt } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('credit');

/** Active transaction handle — matches `dispatch.ts`'s local alias. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CashCoverageVerdict {
  /** Does this wallet have ANY open receivable? `false` ⇒ there is nothing to clear. */
  hasOpenReceivable: boolean;
  /**
   * Does the company's OWN money cover the outstanding debt? Always `false` when nothing is
   * open — "covered" is a claim about a debt, and there is no debt to make it about.
   */
  covered: boolean;
  /** The live post-credit balance the verdict was computed from (AUD minor; may be negative). */
  balanceMinor: number;
  /** Promo credit granted since the oldest open debt became outstanding (AUD minor; `>= 0`). */
  promoGrantedSinceDebtMinor: number;
  /** `balanceMinor − promoGrantedSinceDebtMinor` — the figure the predicate actually judged. */
  cashBackedBalanceMinor: number;
}

/**
 * Ask whether the company's cash covers what it owes, on a wallet, right now.
 *
 * @param exec the CALLER'S transaction — never the bare `db`. The verdict is only meaningful
 *   inside the transaction that acts on it.
 * @param walletId the wallet whose debt is in question.
 * @param balanceMinor the wallet's live balance. R3 passes `applyLedgerEntry`'s returned
 *   post-credit wallet (so no extra wallet read is introduced anywhere in `dispatch.ts`); both
 *   R3b sites pass their own fresh in-transaction read.
 */
export async function assessCashCoverage(
  exec: DbTx,
  walletId: string,
  balanceMinor: number
): Promise<CashCoverageVerdict> {
  const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(walletId, exec);
  if (anchor === undefined) {
    return {
      hasOpenReceivable: false,
      covered: false,
      balanceMinor,
      promoGrantedSinceDebtMinor: 0,
      cashBackedBalanceMinor: balanceMinor,
    };
  }
  const promoGrantedSinceDebtMinor = await creditLedgerRepository.sumPromoGrantedSince(
    { walletId, since: anchor },
    exec
  );
  return {
    hasOpenReceivable: true,
    covered: creditCoversOutstandingDebt(balanceMinor, promoGrantedSinceDebtMinor),
    balanceMinor,
    promoGrantedSinceDebtMinor,
    cashBackedBalanceMinor: balanceMinor - promoGrantedSinceDebtMinor,
  };
}

/**
 * Which of the two late-open sites recorded the settlement failure. Carried into the audit row
 * so the provenance names the path, not just the outcome.
 */
export type LateReceivableOrigin = 'end_session' | 'stripe_webhook';

/** The just-opened (or idempotently returned) receivable, in the shape this decision needs. */
export interface LateOpenedReceivable {
  id: string;
  companyId: string;
  sessionId: string;
  amountMinor: number;
}

/**
 * R3b (BAL-535, ADR-1040 Amendment 6 §F residual) — THE SHARED late-open self-clear, used
 * verbatim by BOTH sites that can open a receivable over a debt a covering credit has already
 * absorbed: `openReceivableAndDun` (`credit-session/end-session.ts`) and
 * `handleOverdraftChargeFailed` (`stripe/dispatch.ts`). A settlement failure is a real event
 * worth recording, so the row still opens; whether it stays open is this one decision.
 *
 * Returns `true` when the debt was already covered — the caller clears nothing further and
 * SUPPRESSES its dunning publish.
 *
 * ⚠⚠ IT IGNORES `created`, AND THE TWO CALLERS NOW AGREE ON THAT (fix round N3). They used to
 * disagree: `handleOverdraftChargeFailed` returned early on `!created` and never asked, while
 * `openReceivableAndDun` asked unconditionally. Coverage is a fact about the WALLET, not about
 * which path happened to insert the row, so the honest answer cannot depend on that flag — and
 * the clear is safe when it is irrelevant, because `clear()` matches only `status = 'open'` and
 * no-ops on a row the sibling path already cleared. `created` keeps its ONE job: gating the
 * dunning publish so a failed session is dunned exactly once (BAL-378 FIX 5).
 *
 * ⚠ THE CLEAR LEAVES A TRACE — a DISTINCT audit action (fix round N2). Amendment 6 §G.3 makes
 * the provenance row the thing a future SCA re-confirm surface MUST consult before crediting a
 * settlement, §4(e) tabulates it as distinguishing evidence, and §J counts it. A silent clear
 * satisfies none of those. `cleared_on_late_open` (vs R3's `cleared_by_credit`) is what makes
 * "the hold never really existed" separable from "a top-up lifted a live hold".
 *
 * ⚠ NO NOTIFICATION AND NO ANALYTICS HERE, DELIBERATELY — the audit row is the record, and §J's
 * count reads it. On the `created` arm the receivable opened and cleared inside ONE uncommitted
 * transaction: no client ever saw a hold and no dunning was published, so an "account clear"
 * notice would announce the resolution of a problem that never reached them. On the `!created`
 * arm the sibling path owns the row, and for it to still be OPEN here a covering credit would
 * have had to land without R3 clearing it — which the wallet lock both callers now take (M2)
 * forecloses. Where that leaves a real, dunned hold released quietly, the audit row is the
 * evidence, and lifting a hold the client no longer owes is the correct outcome regardless.
 */
export async function clearLateOpenedReceivableIfCovered(
  exec: DbTx,
  input: {
    receivable: LateOpenedReceivable;
    walletId: string;
    /** The wallet's balance, read fresh INSIDE the caller's transaction under its wallet lock. */
    balanceMinor: number;
    /** `false` ⇒ the sibling path had already opened this session's receivable. */
    created: boolean;
    openedBy: LateReceivableOrigin;
    /** The failed / SCA PaymentIntent, when the caller has one. */
    stripePaymentIntentId: string | null;
    /** The acting member, when there is one (`null` on the webhook path — no human actor). */
    actorUserId: string | null;
  }
): Promise<boolean> {
  const { receivable, walletId, balanceMinor, created, openedBy } = input;
  const coverage = await assessCashCoverage(exec, walletId, balanceMinor);
  if (!coverage.covered) {
    return false;
  }
  const cleared = await creditReceivablesRepository.clear({ receivableId: receivable.id }, exec);
  if (cleared !== undefined) {
    await auditEventsRepository.record(
      {
        actorUserId: input.actorUserId,
        action: 'credit_receivable.cleared_on_late_open',
        entityType: 'credit_receivable',
        entityId: receivable.id,
        metadata: {
          walletId,
          companyId: receivable.companyId,
          sessionId: receivable.sessionId,
          openedBy,
          created,
          receivableAmountMinor: receivable.amountMinor,
          predicateBalanceMinor: coverage.balanceMinor,
          promoDiscountedMinor: coverage.promoGrantedSinceDebtMinor,
          cashBackedBalanceMinor: coverage.cashBackedBalanceMinor,
          stripePaymentIntentId: input.stripePaymentIntentId,
        },
      },
      exec
    );
  }
  log.info(
    {
      op: 'clearLateOpenedReceivableIfCovered',
      kind: 'receivable_cleared_on_late_open',
      walletId,
      companyId: receivable.companyId,
      sessionId: receivable.sessionId,
      receivableId: receivable.id,
      openedBy,
      created,
      clearedNow: cleared !== undefined,
      predicateBalanceMinor: coverage.balanceMinor,
      promoDiscountedMinor: coverage.promoGrantedSinceDebtMinor,
      cashBackedBalanceMinor: coverage.cashBackedBalanceMinor,
    },
    'Late settlement failure recorded over an already-covered debt — no hold imposed'
  );
  return true;
}
