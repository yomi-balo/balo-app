'use server';

import 'server-only';

import { performGuestInvite } from '@/lib/meetings/invite-guests-flow';
import type { InviteMeetingGuestsResult } from '@/lib/meetings/meeting-panels';

/**
 * BAL-436 — invite people to a live call by email, from the People panel's footer.
 *
 * The flow, the auth gate and the copy mapping all live in `invite-guests-flow.ts`, shared with
 * the case surface's own entry point (BAL-573); this file supplies the one thing that differs —
 * `entryPoint`, which the api requires and never defaults (`guests.schema.ts:42-47`).
 */
export async function inviteMeetingGuestsAction(input: {
  meetingId: string;
  emails: readonly string[];
}): Promise<InviteMeetingGuestsResult> {
  return performGuestInvite({ ...input, entryPoint: 'in_call' });
}
