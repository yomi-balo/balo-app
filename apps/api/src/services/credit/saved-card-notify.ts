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
  // BAL-521 (DEC-7) — `.`-JOINED, NEVER `:`-JOINED. `notifications/engine/dispatcher.ts:73`
  // builds the per-CHANNEL BullMQ jobId from the RAW correlationId with NO escape (unlike
  // `notifications/publisher.ts`'s `toJobId`, which DOES escape colons for the top-level
  // notification-events jobId) — BullMQ 5.70.4 throws unless the correlationId's colon count is
  // exactly 0 or 2, so a ONE-colon id would die at `channelQueue.add` and the notice would never
  // be delivered. Stripe event ids (`evt_…`) and uuids never contain a `.`, so this join is
  // colon-free by construction regardless of what the parts turn out to be. Several SHIPPED
  // credit correlationIds ARE one-colon-joined and are very likely failing at that same line
  // today — a real, separate defect, out of scope here (do not "fix" `dispatcher.ts`).
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
