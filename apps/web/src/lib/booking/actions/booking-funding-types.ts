import type { SavedCard } from '@/components/billing/top-up/types';

/**
 * Wire types for the inline-funding actions (`read-booking-funding.ts`,
 * `save-booking-for-later.ts`). Kept in a SIBLING, non-`'use server'` module because a
 * `'use server'` module may export ONLY async functions (see `types.ts`).
 */

/** Which refusal the view is showing: no usable funding, planned consultations, or an open hold. */
export type BookingFundingArm = 'setup' | 'reserved' | 'hold';

export interface BookingFundingRequest {
  expertProfileId: string;
  slot: {
    startIso: string;
    endIso: string;
    durationMinutes: 15 | 30 | 45 | 60;
  };
  caseChoice: { kind: 'new'; companyId?: string } | { kind: 'existing'; engagementId: string };
}

/** What the top-up controls need: the card on file. The booking top-up never touches the low-balance setting. */
export interface BookingTopUpWallet {
  savedCard: SavedCard | null;
}

/**
 * The read-only pre-flight's answer.
 *
 * ⚠ THE VIEW NEVER CARRIES A RATE, AN ESTIMATE, AN AVAILABLE FIGURE OR A RESERVED FIGURE. The only
 * money it names is the top-up the client would be asked to make: `topUpNeededMinor` (the figure
 * the refusal states, `null` on the setup arm and on a failed-heal hold) and `suggestedTopUpMinor`
 * (the amount that makes the booking pass, `null` for a viewer who cannot manage billing).
 * `wallet` and `firstTime` are read only for a billing manager of the active workspace company;
 * otherwise `wallet` is `null`.
 */
export type BookingFundingView =
  | { kind: 'clear' }
  | { kind: 'unavailable' }
  | {
      kind: 'refused';
      arm: BookingFundingArm;
      canManageBilling: boolean;
      company: { id: string; name: string | null; isActive: boolean };
      firstTime: boolean;
      topUpNeededMinor: number | null;
      reservedBookingCount: number | null;
      suggestedTopUpMinor: number | null;
      wallet: BookingTopUpWallet | null;
    };

export type SaveBookingForLaterResult =
  | { ok: true }
  | { ok: false; reason: 'not_refused' | 'refused' | 'failed' };
