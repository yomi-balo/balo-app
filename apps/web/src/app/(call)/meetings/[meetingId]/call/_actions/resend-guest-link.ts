'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resendMeetingGuestLink } from '@/lib/meetings/guests-api-client';
import { GUEST_ACTION_COPY, guestActionCopyFor } from '@/lib/meetings/guests-copy';
import type { ResendLinkActionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z.object({ meetingId: z.uuid(), guestId: z.uuid() });

/**
 * BAL-436 — a host re-sends the join link to somebody they admitted who never arrived.
 *
 * ⚠⚠ **THE EMAIL GOES THROUGH THE NOTIFICATION ENGINE, FROM `apps/api`.** This action forwards
 * one authenticated request and learns only that a rotation happened. It never touches Brevo,
 * never renders a template, never writes a notification row, and never sees the token — which
 * is the whole reason the mint lives in `apps/api`: the credential stays inside ONE process
 * from creation to enqueue.
 *
 * ⚠⚠ **THE RE-SEND ROTATES THE CREDENTIAL, SO THE PREVIOUS LINK DIES.** That is deliberate —
 * the host is re-sending precisely because the old one is believed lost, and two live
 * credentials on one row is a second hijack surface. The panel's helper line says so in as
 * many words ("This replaces the link they had"), because a silently-dead link is worse for
 * the person holding it than a link they were told was replaced.
 *
 * ⚠ RE-SENDING IS NOT VERIFYING. The row stays UNVERIFIED in the panel and the badge does not
 * move: the address was typed by an anonymous visitor, and mailing it again says nothing about
 * who they are.
 *
 * ⚠ MUTATING ⇒ `requireOnboardedUser()`. ⚠ NO ADDRESS AND NO TOKEN IN ANY LOG LINE.
 */
export async function resendGuestLinkAction(input: {
  meetingId: string;
  guestId: string;
}): Promise<ResendLinkActionResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    log.error('Guest link re-send rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_ACTION_COPY.unauthenticated };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { meetingId, guestId } = parsed.data;

  const result = await resendMeetingGuestLink(meetingId, guestId);
  if (!result.ok) {
    log.error('Guest link re-send refused', {
      meetingId,
      guestId,
      status: result.status,
      code: result.code,
    });
    return { success: false, error: guestActionCopyFor(result) };
  }

  // ⚠ A CREDENTIAL WAS ISSUED. `apps/api` logs the authoritative line; this one records that
  // the in-call panel was the surface that asked for it, which is the funnel question.
  log.info('Guest link re-sent from the in-call panel', { meetingId, guestId });
  return { success: true };
}
