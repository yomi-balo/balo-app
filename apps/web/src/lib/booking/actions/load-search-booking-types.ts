import type { BookingContext, BookingFlowExpert } from '@/components/booking/types';

export interface LoadSearchBookingInput {
  username: string;
}

/**
 * `signed_out` → the caller opens the auth modal and retries. `unavailable` covers every case
 * the profile page handles better (unknown or paused expert, failed read): the caller falls back
 * to the `?book=1` deep link.
 */
export type LoadSearchBookingResult =
  | {
      ok: true;
      expert: BookingFlowExpert;
      context: BookingContext;
      viewerEmailDomain: string | null;
    }
  | { ok: false; reason: 'signed_out' | 'unavailable' };
