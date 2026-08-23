import type { BookingContext } from '@/components/booking/types';

export interface RefetchBookingContextInput {
  expertProfileId: string;
}

export type RefetchBookingContextResult = { ok: true; context: BookingContext } | { ok: false };
