import type { SavedCardDetachSource } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { notificationEvents } from '../../notifications/publisher.js';

const log = createLogger('stripe');

/**
 * BAL-521 §3 (DEC-6 File 7) — the ONE publisher BOTH doors call for `credit.saved_card.detached`,
 * so the webhook arm (`services/stripe/dispatch.ts`) and the user-initiated arm
 * (`services/stripe/mandate.ts`) can never drift in shape. Fields are DISPLAY facts and IDs only
 * — never a money figure, never a Stripe secret, never `mandateRef`.
 */
export interface SavedCardDetachedNotice {
  walletId: string;
  companyId: string;
  source: SavedCardDetachSource;
  /** True ⇒ a card-backed low-balance mode was disarmed to `notify_only` by this detach. */
  modeReconciled: boolean;
  /** The mode armed BEFORE the reconcile — what the copy names as "now off". */
  previousLowBalanceMode: 'auto_topup' | 'keep_going' | 'notify_only';
  /** `null` on a non-card payment method, or a wallet whose display columns were already null.
   *  BOTH are null together, never one alone — see `CreditSavedCardDetachedPayload`. */
  cardBrand: string | null;
  cardLast4: string | null;
  /** The door-specific second half of the correlationId (DEC-7): the Stripe EVENT id on the
   *  webhook door, the audit-row id on the user door. */
  dedupKey: string;
  /** The acting member. `null` on the webhook door — Stripe has no human actor to name. */
  detachedByUserId: string | null;
}

/**
 * Best-effort + idempotent by `correlationId`. NEVER throws — by the time either door calls this,
 * the wallet clear (and its audit row) has ALREADY committed. Re-throwing would either turn a
 * completed removal into a 500 (the user door) or make Stripe retry a whole webhook for a
 * notification hiccup (the webhook door). Same posture as `dispatch.ts`'s `publishTopupReceipt`.
 */
export async function publishSavedCardDetached(notice: SavedCardDetachedNotice): Promise<void> {
  // BAL-521 (DEC-7) — `.`-JOINED, NEVER `:`-JOINED. `engine/dispatcher.ts`'s delivery enqueue
  // (the `enqueueDelivery` helper) builds the per-CHANNEL BullMQ jobId via
  // `buildJobId(rule.template, recipientId, correlationId)` (BAL-531) — a colon in the
  // correlationId is no longer fatal there, since `buildJobId` escapes it. The `.`-join stays
  // anyway: it keeps the emitted correlationId readable, and Stripe event ids (`evt_…`) and
  // uuids never contain a `.`, so this join is colon-free by construction regardless of what
  // the parts turn out to be. (Named by symbol, not line number — a line-number pointer at this
  // exact spot has already rotted twice across BAL-531's own fix rounds.)
  const correlationId = `saved-card-detached.${notice.walletId}.${notice.dedupKey}`;
  try {
    await notificationEvents.publish('credit.saved_card.detached', {
      correlationId,
      companyId: notice.companyId,
      walletId: notice.walletId,
      source: notice.source,
      modeReconciled: notice.modeReconciled,
      previousLowBalanceMode: notice.previousLowBalanceMode,
      // BOTH absent when either is unknown — never a half-filled card label, and never an
      // `undefined`-valued key (the payload's fields are optional, not nullable).
      ...(notice.cardBrand !== null && notice.cardLast4 !== null
        ? { cardBrand: notice.cardBrand, cardLast4: notice.cardLast4 }
        : {}),
      // ⚠ NOT named `userId` (D12) — see the payload's own docblock for why.
      ...(notice.detachedByUserId === null ? {} : { detachedByUserId: notice.detachedByUserId }),
    });
  } catch (err: unknown) {
    log.error(
      {
        op: 'publishSavedCardDetached',
        correlationId,
        walletId: notice.walletId,
        source: notice.source,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish credit.saved_card.detached (the card is already cleared; notification best-effort)'
    );
  }
}
