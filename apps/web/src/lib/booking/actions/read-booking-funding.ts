'use server';
import 'server-only';

import { z } from 'zod';
import { creditWalletsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { walletHasEverHeldCredit, projectBookingTopUpWallet } from '@/lib/credit/wallet-read';
import { assessBookingFunding, type BookingFundingRefusal } from '../booking-funding-gate';
import { bookingSlotSchema } from '../booking-slot-schema';
import { resolveFundingSubject } from '../resolve-funding-subject';
import type { BookingFundingRequest, BookingFundingView } from './booking-funding-types';

/**
 * BAL-608 — the read-only funding PRE-FLIGHT behind the inline fix on Review & confirm.
 *
 * ⚠⚠ IT DECIDES AND TELLS NOBODY. It runs the booking's own verdict through
 * `assessBookingFunding`, which logs no refusal, publishes no `booking.funding_blocked` notice and
 * fires no analytics event: opening the step must never fan out to a company's billing admins. The
 * refusal point that does is the submit (`bookConsultationAction`) or a member's Save
 * (`saveBookingForLaterAction`), both through `enforceBookingFunding`.
 *
 * ⚠ THE VIEW CARRIES NO RATE, ESTIMATE, AVAILABLE OR RESERVED FIGURE — only the top-up the client
 * would make (`BookingFundingView`). The wallet (saved card + current low-balance preference) and
 * the first-time flag are read only for a billing manager of the ACTIVE workspace company, the one
 * audience that can top up inline; everyone else gets `wallet: null`.
 *
 * ⚠ A READ ERROR IS NOT A REFUSAL. Anything unreadable is `unavailable`, which renders nothing
 * inline, so the gate decides at submit exactly as it did before this view existed.
 */

const requestSchema = z
  .object({
    expertProfileId: z.string().uuid(),
    slot: bookingSlotSchema,
    caseChoice: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('new'), companyId: z.string().uuid().optional() }).strict(),
      z.object({ kind: z.literal('existing'), engagementId: z.string().uuid() }).strict(),
    ]),
    onCoveredHold: z.enum(['defer', 'refuse']).optional(),
  })
  .strict();

const ARM_BY_REASON = {
  unfunded: 'setup',
  on_hold: 'hold',
  reserved: 'reserved',
} as const;

/** Read the wallet only for the one audience that can top up inline. */
async function readManagerWallet(
  refusal: BookingFundingRefusal
): Promise<Pick<Extract<BookingFundingView, { kind: 'refused' }>, 'wallet' | 'firstTime'>> {
  const setupWithoutWallet = refusal.reason === 'unfunded' && refusal.setupKind === 'no_wallet';
  if (!refusal.canManageBilling || !refusal.billingCompany.isActive) {
    return { wallet: null, firstTime: setupWithoutWallet };
  }
  const row = await creditWalletsRepository.findByCompanyId(refusal.billingCompany.id);
  return {
    wallet: projectBookingTopUpWallet(row),
    firstTime: setupWithoutWallet || !walletHasEverHeldCredit(row),
  };
}

async function toRefusedView(refusal: BookingFundingRefusal): Promise<BookingFundingView> {
  const { wallet, firstTime } = await readManagerWallet(refusal);
  return {
    kind: 'refused',
    arm: ARM_BY_REASON[refusal.reason],
    canManageBilling: refusal.canManageBilling,
    company: refusal.billingCompany,
    firstTime,
    topUpNeededMinor: refusal.reason === 'unfunded' ? null : refusal.topUpNeededMinor,
    reservedBookingCount: refusal.reason === 'reserved' ? refusal.reservedBookingCount : null,
    suggestedTopUpMinor: refusal.canManageBilling ? refusal.suggestedTopUpMinor : null,
    wallet,
  };
}

export async function readBookingFundingAction(
  rawInput: BookingFundingRequest & { onCoveredHold?: 'defer' | 'refuse' }
): Promise<BookingFundingView> {
  const user = await requireOnboardedUser();

  const parsed = requestSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Booking funding pre-flight failed validation', {
      userId: user.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    return { kind: 'unavailable' };
  }
  const input = parsed.data;

  try {
    const subject = await resolveFundingSubject(user.id, {
      expertProfileId: input.expertProfileId,
      caseChoice: input.caseChoice,
    });
    if (!subject.ok) {
      return { kind: 'unavailable' };
    }

    const result = await assessBookingFunding({
      actorUserId: user.id,
      companyId: subject.companyId,
      expertProfileId: subject.expertProfileId,
      slot: { startIso: input.slot.startIso, endIso: input.slot.endIso },
      activeCompanyId: user.companyId,
      onCoveredHold: input.onCoveredHold ?? 'defer',
    });
    if (result.ok) {
      return { kind: 'clear' };
    }
    if (result.reason === 'unavailable') {
      return { kind: 'unavailable' };
    }
    return await toRefusedView(result);
  } catch (error) {
    log.error('Booking funding pre-flight failed', {
      userId: user.id,
      expertProfileId: input.expertProfileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'unavailable' };
  }
}
