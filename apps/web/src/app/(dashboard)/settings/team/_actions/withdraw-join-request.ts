'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { partyJoinRequestsRepository, InvalidJoinRequestTransitionError } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import type { ActionResult } from './join-request-shared';

const inputSchema = z.object({ requestId: z.uuid() });

/**
 * Withdraw one's OWN pending domain join request (BAL-345 §5.3). NOT a capability
 * gate — a self-ownership check (`request.userId === session.id`), because a
 * requester withdraws their own pending request. No admin notification.
 */
export async function withdrawJoinRequest(input: { requestId: string }): Promise<ActionResult> {
  let session;
  try {
    session = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You must be signed in to do this.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  const request = await partyJoinRequestsRepository.findById(requestId);
  if (request === undefined) {
    return { success: false, error: 'This request could not be found.' };
  }
  // Self-ownership: only the requester may withdraw their own request.
  if (request.userId !== session.id) {
    return { success: false, error: 'You do not have permission to do this.' };
  }

  try {
    await partyJoinRequestsRepository.withdraw({ requestId, actorUserId: session.id });
    revalidatePath('/settings/team');
    return { success: true };
  } catch (error) {
    log.error('Failed to withdraw join request', {
      requestId,
      actorUserId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (error instanceof InvalidJoinRequestTransitionError) {
      return { success: false, error: 'This request is no longer pending.' };
    }
    return { success: false, error: 'Could not withdraw this request. Please try again.' };
  }
}
