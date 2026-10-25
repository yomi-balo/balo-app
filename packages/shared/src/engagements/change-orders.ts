/**
 * Change-order money and estimate helpers, pure and shared by the web view models and actions.
 *
 * The client never sees the expert figure and the expert never sees the client one, so every
 * client-side amount here is DERIVED from expert-side cents through `applyBaloFee` at the
 * engagement's fee. A client delta is the difference of two client effective prices, never
 * the fee applied to the expert delta: rounding the delta alone drifts from the difference of the two rounded prices.
 */
import { applyBaloFee } from '../pricing';

/** Whole business days a sent change order may wait before the Balo team is alerted. */
export const CHANGE_ORDER_STALE_BUSINESS_DAYS = 5;

/** What a change-order line does to a milestone. */
export type ChangeOrderLineOp = 'add' | 'edit' | 'remove';

/**
 * The change in what the client pays when the expert-side price moves `fromExpert` to
 * `toExpert`: `applyBaloFee(to) - applyBaloFee(from)`.
 */
export function clientPriceChangeCents(
  fromExpert: number,
  toExpert: number,
  feeBps: number
): number {
  return applyBaloFee(toExpert, feeBps) - applyBaloFee(fromExpert, feeBps);
}

/** An expert price, the client price it grosses up to, and the Balo margin between them. */
export interface SettlementPrice {
  expertCents: number;
  clientCents: number;
  marginCents: number;
}

/** One approved change order's effect on the price, in decision order. */
export interface SettlementDelta {
  expertDeltaCents: number;
  clientDeltaCents: number;
  marginDeltaCents: number;
}

export interface ProjectSettlementInput {
  /** The expert-side price when the project was accepted. */
  acceptedPriceCents: number;
  /** Expert-side deltas of the approved change orders, oldest decision first. */
  approvedDeltasInOrder: readonly number[];
  baloFeeBps: number;
  /** What the client has already been invoiced up front (deposit plus installments). */
  upfrontDueClientCents: number;
}

export interface ProjectSettlement {
  accepted: SettlementPrice;
  approved: SettlementDelta[];
  current: SettlementPrice;
  upfrontClientCents: number;
  /** The client price now, less what was invoiced up front. Negative when over-invoiced. */
  finalInvoiceClientCents: number;
  /** The adjustment note owed to the client when the final invoice is below zero, else 0. */
  creditRequiredClientCents: number;
}

function priceAt(expertCents: number, feeBps: number): SettlementPrice {
  const clientCents = applyBaloFee(expertCents, feeBps);
  return { expertCents, clientCents, marginCents: clientCents - expertCents };
}

/**
 * Walks the approved deltas cumulatively. Each row's client delta is the difference between
 * consecutive client effective prices, so the rows add up to exactly
 * `current.clientCents - accepted.clientCents`.
 */
export function deriveProjectSettlement(input: ProjectSettlementInput): ProjectSettlement {
  const { acceptedPriceCents, approvedDeltasInOrder, baloFeeBps, upfrontDueClientCents } = input;
  const accepted = priceAt(acceptedPriceCents, baloFeeBps);
  const approved: SettlementDelta[] = [];
  let running = accepted;
  for (const expertDeltaCents of approvedDeltasInOrder) {
    const next = priceAt(running.expertCents + expertDeltaCents, baloFeeBps);
    approved.push({
      expertDeltaCents,
      clientDeltaCents: next.clientCents - running.clientCents,
      marginDeltaCents: next.marginCents - running.marginCents,
    });
    running = next;
  }
  const finalInvoiceClientCents = running.clientCents - upfrontDueClientCents;
  return {
    accepted,
    approved,
    current: running,
    upfrontClientCents: upfrontDueClientCents,
    finalInvoiceClientCents,
    creditRequiredClientCents: Math.max(0, -finalInvoiceClientCents),
  };
}

export interface ChangeOrderMinutesLine {
  op: ChangeOrderLineOp;
  estimatedMinutes: number | null;
  beforeEstimatedMinutes: number | null;
}

/**
 * The net change in estimated minutes across a change order's lines: an add contributes its
 * estimate, a remove takes back the estimate it had, and an edit contributes the difference.
 * A missing estimate counts as zero.
 */
export function changeOrderMinutesDelta(lines: readonly ChangeOrderMinutesLine[]): number {
  let total = 0;
  for (const line of lines) {
    const after = line.estimatedMinutes ?? 0;
    const before = line.beforeEstimatedMinutes ?? 0;
    if (line.op === 'add') total += after;
    else if (line.op === 'remove') total -= before;
    else total += after - before;
  }
  return total;
}
