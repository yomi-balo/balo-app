'use server';
import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { loadBookingContext } from '../load-booking-context';
import { serializeBookingContext } from '../serialize-booking-context';
import type {
  RefetchBookingContextInput,
  RefetchBookingContextResult,
} from './refetch-booking-context-types';

/**
 * BAL-400 — the company-eligibility read's "Retry" affordance (design §Company picker's
 * fail-closed error state). `loadBookingContext` never throws, so this action's only job is to
 * re-run it for an already-open wrapper and hand back a fresh, client-safe `BookingContext` —
 * the dialog's own reset effect only runs once per open, so a plain `router.refresh()` would
 * not reach an already-mounted dialog's state.
 */
const inputSchema = z.object({ expertProfileId: z.string().uuid() }).strict();

export async function refetchBookingContextAction(
  rawInput: RefetchBookingContextInput
): Promise<RefetchBookingContextResult> {
  const user = await requireOnboardedUser();
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Booking context refetch rejected — invalid input', { userId: user.id });
    return { ok: false };
  }
  const context = await loadBookingContext(parsed.data.expertProfileId, user.id);
  return { ok: true, context: serializeBookingContext(context) };
}
