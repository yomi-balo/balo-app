'use server';
import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import { assessBookingFunding, enforceBookingFunding } from '../booking-funding-gate';
import { bookingSlotSchema } from '../booking-slot-schema';
import { resolveFundingSubject } from '../resolve-funding-subject';
import type { BookingFundingRequest, SaveBookingForLaterResult } from './booking-funding-types';

/**
 * BAL-608 — "Save and finish later" for a member who cannot top up. The refusal point that
 * replaces the old submit-time dead end for that audience: a member's refusal runs `enforceBookingFunding`, so the
 * billing-admin fan-out (`booking.funding_blocked`) and its analytics event fire here, exactly
 * once, with the payload and correlationId a submit refusal would have produced.
 *
 * ⚠ IT BOOKS NOTHING AND HOLDS NO TIME. It writes no case, engagement or meeting; the draft stays
 * on the member's device. `ok` means "a still-refused member's billing admins were told".
 *
 *  · funded by now, or a billing manager (who would top up, not save) ⇒ `not_refused`, no notice;
 *  · an impersonated session ⇒ `refused` (a notice to real billing admins on a customer's behalf);
 *  · an unreadable funding state (on either read, so the publishing gate is never reached), or
 *    anything that throws ⇒ `failed`.
 */

const requestSchema = z
  .object({
    expertProfileId: z.uuid(),
    slot: bookingSlotSchema,
    caseChoice: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('new'), companyId: z.uuid().optional() }).strict(),
      z.object({ kind: z.literal('existing'), engagementId: z.uuid() }).strict(),
    ]),
  })
  .strict();

/** An unreadable funding state is a failure, never a licence to publish: log it and stop. */
function failedUnavailable(
  userId: string,
  companyId: string,
  expertProfileId: string
): SaveBookingForLaterResult {
  log.error('Save booking for later — funding state unavailable', {
    userId,
    companyId,
    expertProfileId,
  });
  return { ok: false, reason: 'failed' };
}

export async function saveBookingForLaterAction(
  rawInput: BookingFundingRequest
): Promise<SaveBookingForLaterResult> {
  const user = await requireOnboardedUser();

  if (isImpersonatedSession(user)) {
    log.warn('Save booking for later refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
    });
    return { ok: false, reason: 'refused' };
  }

  const parsed = requestSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Save booking for later failed validation', {
      userId: user.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    return { ok: false, reason: 'failed' };
  }
  const input = parsed.data;

  try {
    const subject = await resolveFundingSubject(user.id, {
      expertProfileId: input.expertProfileId,
      caseChoice: input.caseChoice,
    });
    if (!subject.ok) {
      log.warn('Save booking for later — funding subject not resolvable', {
        userId: user.id,
        expertProfileId: input.expertProfileId,
      });
      return { ok: false, reason: 'failed' };
    }

    const funding = {
      actorUserId: user.id,
      companyId: subject.companyId,
      expertProfileId: subject.expertProfileId,
      slot: { startIso: input.slot.startIso, endIso: input.slot.endIso },
      activeCompanyId: user.companyId,
      onCoveredHold: 'defer',
    } as const;

    // A billing manager tops up instead of saving, so a read-only assess decides first and a
    // manager (or a passing booking) never reaches the publishing gate.
    const preflight = await assessBookingFunding(funding);
    if (!preflight.ok && preflight.reason === 'unavailable') {
      return failedUnavailable(user.id, subject.companyId, subject.expertProfileId);
    }
    if (preflight.ok || preflight.canManageBilling) {
      return { ok: false, reason: 'not_refused' };
    }

    const result = await enforceBookingFunding(funding);
    if (result.ok) {
      return { ok: false, reason: 'not_refused' };
    }
    if (result.reason === 'unavailable') {
      return failedUnavailable(user.id, subject.companyId, subject.expertProfileId);
    }
    if (result.canManageBilling) {
      return { ok: false, reason: 'not_refused' };
    }

    log.info('Booking saved for later — billing admins notified', {
      userId: user.id,
      companyId: subject.companyId,
      expertProfileId: subject.expertProfileId,
    });
    return { ok: true };
  } catch (error) {
    log.error('Save booking for later failed', {
      userId: user.id,
      expertProfileId: input.expertProfileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
