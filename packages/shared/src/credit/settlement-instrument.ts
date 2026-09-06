/**
 * BAL-525 (ADR-1040 Amendment 5) — the pure SELECTION between two already-authorized Stripe
 * pairs: the session's pinned settlement instrument (a snapshot of the wallet's Stripe pair
 * taken while the debt was accruing — see the BAL-525 docblock on
 * `packages/db/src/schema/credit-sessions.ts`) and the wallet's LIVE pair, which the caller has
 * already proved chargeable (`isWalletMandateActive` + null-narrowing) before ever constructing
 * the input below.
 *
 * ⚠ NOT A CARD-STATE PREDICATE — A NEW MODULE ON PURPOSE. `settlement.ts:59-64` bans widening
 * `isWalletMandateActive` / `isWalletCardReusableOnSession` into each other, and a THIRD or
 * FOURTH card predicate landing in that file needs its own justification (pre-flight §11). This
 * is not a predicate over a wallet's card state at all — it is a SELECTION between two pairs
 * that are each already authorized on their own terms. Keeping it in its own module makes that
 * distinction structural rather than a comment that can rot.
 *
 * ⚠⚠ EVIDENCE AND PREFERENCE, NEVER AUTHORITY — **SETTLED, PERMANENTLY** (ADR-1040 Amendment 6
 * §E, BAL-535). On disagreement this resolves to the LIVE pair, never the pin. Authority over
 * the pin was ruled out, not deferred: an authoritative pin routes a debt to a receivable, and a
 * receivable has no collection arm (`receivable-dunning-sweep.ts` imports no Stripe client).
 * Amendment 5 §E's fixed per-session idempotency key independently forecloses any "try the pin,
 * then fall back" ladder. The anti-collapse assertions in
 * `packages/db/src/invariants/session-debt-carries-its-collection-instrument.test.ts` fail by
 * name if this is ever reversed.
 */

/** A chargeable Stripe pair. Both ids non-null BY TYPE — see the ⚠ note on the resolver below. */
export interface SettlementInstrument {
  customerId: string;
  paymentMethodId: string;
}

export type SettlementInstrumentSource = 'pinned' | 'wallet';

export interface ResolvedSettlementInstrument extends SettlementInstrument {
  source: SettlementInstrumentSource;
  /** TRUE only when a COMPLETE pin exists and names a different pair than the live wallet. */
  pinDisagrees: boolean;
}

export interface SettlementInstrumentCandidates {
  /** The session's snapshot. Either id NULL ⇒ no usable pin (the pair CHECK makes half-set unreachable in production, but the resolver treats it as absent regardless). */
  pinned: { customerId: string | null; paymentMethodId: string | null };
  /** The wallet's LIVE pair, already proved chargeable by `isWalletMandateActive` + narrowing. */
  live: SettlementInstrument;
}

/**
 * Resolve which Stripe pair settlement should charge.
 *
 * ⚠ Why `live` is non-nullable by TYPE, and why that matters: it encodes O3's ordering in the
 * signature. A caller who has not run `isWalletMandateActive` and narrowed the wallet's two
 * nullable ids literally cannot construct this input — resolving an instrument is only possible
 * once live consent has already been proved.
 *
 * Rules (this is the whole body):
 *   - either pinned id is NULL            → live wins, no disagreement.
 *   - pinned is complete and matches live → pinned wins, no disagreement.
 *   - pinned is complete but differs      → live wins, `pinDisagrees: true`.
 */
export function resolveSettlementInstrument(
  input: SettlementInstrumentCandidates
): ResolvedSettlementInstrument {
  const { pinned, live } = input;
  const { customerId: pinnedCustomerId, paymentMethodId: pinnedPaymentMethodId } = pinned;

  if (pinnedCustomerId === null || pinnedPaymentMethodId === null) {
    return { ...live, source: 'wallet', pinDisagrees: false };
  }

  const pinAgreesWithLive =
    pinnedCustomerId === live.customerId && pinnedPaymentMethodId === live.paymentMethodId;

  if (pinAgreesWithLive) {
    return {
      customerId: pinnedCustomerId,
      paymentMethodId: pinnedPaymentMethodId,
      source: 'pinned',
      pinDisagrees: false,
    };
  }

  return { ...live, source: 'wallet', pinDisagrees: true };
}
