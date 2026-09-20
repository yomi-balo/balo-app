'use server';

import 'server-only';

import { performGuestInvite } from '@/lib/meetings/invite-guests-flow';
import type { InviteMeetingGuestsResult } from '@/lib/meetings/meeting-panels';

/**
 * BAL-573 — invite a colleague to one upcoming consultation, from its row on the case surface.
 *
 * ⚠ NO ENGAGEMENT ID AND NO TENANCY CHECK HERE, AND THAT IS NOT AN OMISSION. The api's own gate
 * is `authorizeMeetingParticipation` on the MEETING — party membership on both sides — so it
 * re-derives the answer from the meeting's primary context without trusting anything this hop
 * sends. `canInvite` on the row is a RENDER HINT; this is a thin, authenticated forwarder.
 *
 * ⚠ `emails` ONLY. The api's `guestInvitee` accepts an optional `name`, and the composer never
 * collects one — a nameless guest is greeted generically, never by their email local part.
 */
export async function inviteConsultationGuestsAction(input: {
  meetingId: string;
  emails: readonly string[];
}): Promise<InviteMeetingGuestsResult> {
  return performGuestInvite({ ...input, entryPoint: 'case_surface' });
}
