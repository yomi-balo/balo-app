import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import type { BookingFundingView } from '@/lib/booking/actions/booking-funding-types';

export type RefusedFundingView = Extract<BookingFundingView, { kind: 'refused' }>;

/** Where a pre-flight answer is shown: nowhere, under the form, or in today's full panel. */
export type FundingDisposition = 'none' | 'inline' | 'panel';

/**
 * The one rule for how a funding answer is presented.
 *
 *  · No refusal (no answer yet, clear, unavailable) ⇒ `none`.
 *  · A member ⇒ `inline`. They have no top-up to run, so neither the active-workspace nor the
 *    single-top-up limit applies to them; they only save the booking for a billing admin.
 *  · A billing manager ⇒ `inline`, unless the top-up cannot run from here: the refusing company is
 *    not the active workspace, the amount is above one top-up, or there is no wallet projection to
 *    pay with. Those keep the full panel.
 */
export function resolveFundingDisposition(view: BookingFundingView | null): FundingDisposition {
  if (view?.kind !== 'refused') return 'none';
  if (!view.canManageBilling) return 'inline';
  const cannotTopUpHere =
    !view.company.isActive ||
    view.suggestedTopUpMinor === null ||
    view.suggestedTopUpMinor > TOP_UP_LIMITS_MINOR.max ||
    view.wallet === null;
  return cannotTopUpHere ? 'panel' : 'inline';
}
