/**
 * Change-order money and estimate helpers, pure and shared by the web view models and actions.
 *
 * The client never sees the expert figure and the expert never sees the client one, so every
 * client-side amount here is DERIVED from expert-side cents through `applyBaloFee` at the
 * engagement's fee. A client delta is the difference of two client effective prices, never
 * the fee applied to the expert delta: rounding the delta alone drifts from the difference of the two rounded prices.
 */
import { applyBaloFee } from '../pricing';
import { addBusinessDays, lastWeekdayOnOrBefore } from '../timezone/business-days';

/** Whole business days a sent change order may wait before the Balo team is alerted. */
export const CHANGE_ORDER_STALE_BUSINESS_DAYS = 5;

/**
 * The latest `sent_at` a change order may carry at `now` and count as stale. A weekend `now`
 * is anchored to the Friday before it (same UTC time of day), so the cutoff is
 * {@link CHANGE_ORDER_STALE_BUSINESS_DAYS} full business days back and an order never reads
 * as stale on the fourth.
 */
export function changeOrderStaleCutoff(now: Date): Date {
  return addBusinessDays(lastWeekdayOnOrBefore(now), -CHANGE_ORDER_STALE_BUSINESS_DAYS);
}

/** Whether an order sent at `sentAt` is stale at `now`: sent on or before the cutoff. */
export function isChangeOrderStale(sentAt: Date, now: Date): boolean {
  return sentAt.getTime() <= changeOrderStaleCutoff(now).getTime();
}

/**
 * Why a plain milestone write was refused and must go through a change order instead:
 * changing an estimate on time and materials, adding a milestone on time and materials, or
 * removing contracted scope on a fixed price.
 */
export const SCOPE_CHANGE_REDIRECT_REASONS = [
  'estimate_change',
  'add_on_tm',
  'remove_contracted',
] as const;

/** @see SCOPE_CHANGE_REDIRECT_REASONS */
export type ScopeChangeRedirectReason = (typeof SCOPE_CHANGE_REDIRECT_REASONS)[number];

/** A refused milestone write, with the project's pricing method. */
export interface ScopeChangeRedirect {
  reason: ScopeChangeRedirectReason;
  pricingMethod: 'fixed' | 'tm';
}

/**
 * Whether a milestone is scope the client agreed to, so removing it on a fixed price needs a
 * change order: it was snapshotted from the accepted proposal, it carries a value, or an
 * approved change order's `add` line created it (`addedByApprovedChangeOrder`). A milestone
 * the expert added with a plain add has none of these and stays removable.
 */
export function isContractedMilestone(
  milestone: { sourceProposalMilestoneId: string | null; valueCents: number | null },
  addedByApprovedChangeOrder: boolean
): boolean {
  return (
    milestone.sourceProposalMilestoneId !== null ||
    milestone.valueCents !== null ||
    addedByApprovedChangeOrder
  );
}

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
