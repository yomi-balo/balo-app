'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, InvalidKickoffStateError, type KickoffGate } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { log } from '@/lib/logging';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated by the access guard.
  relationshipId: z.uuid(),
});

export type CompleteKickoffTaskInput = z.infer<typeof inputSchema>;

export type CompleteKickoffTaskResult =
  | { success: true; gate: 'client_billing' | 'expert_terms' }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_PARTICIPANT = 'Only a participant can complete this step.';
const STALE = 'This kickoff is no longer open.';
const GENERIC_FAILURE = 'Could not complete this step. Please try again.';

/**
 * Client/expert marks THEIR OWN kickoff gate done (BAL-291 / A6.5). The lens the
 * access guard resolves selects which persisted gate this confirms: the client
 * lens clears `client_billing`, the expert lens clears `expert_terms`. The third
 * gate (admin "settle invoice + approve") IS the approval action and lives in
 * `approve-kickoff.ts`, not here.
 *
 * Control flow: requireUser → validate input → `resolveConversationAccess`
 * (denies non-participants + foreign relationship ids, and denies admin
 * observers) → lens→gate map → verify the request AND the relationship are both
 * `accepted` (the kickoff exists only for the accepted deal; this rejects a
 * non-winning expert whose own relationship isn't accepted) → `confirmKickoffGate`
 * (idempotent; `InvalidKickoffStateError` → friendly stale copy) → log →
 * revalidate → return.
 */
export async function completeKickoffTaskAction(
  input: CompleteKickoffTaskInput
): Promise<CompleteKickoffTaskResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    // Map the resolved lens → the persisted gate this participant owns. Admin
    // is already denied by the access guard (it has no participant lens), so the
    // fallthrough is defensive only.
    let gate: KickoffGate;
    if (access.ctx.lens === 'client') {
      gate = 'client_billing';
    } else if (access.ctx.lens === 'expert') {
      gate = 'expert_terms';
    } else {
      return { success: false, error: ONLY_PARTICIPANT };
    }

    // The kickoff board only exists for the accepted deal: both the request
    // aggregate AND this relationship must be `accepted`. A non-winning expert
    // (whose own relationship never reached `accepted`) is rejected here.
    if (access.request.status !== 'accepted' || access.relationship.status !== 'accepted') {
      return { success: false, error: STALE };
    }

    // Confirm the gate (idempotent — first-confirm timestamp is preserved). A
    // status that has moved off `accepted` since the access read trips
    // `InvalidKickoffStateError` → friendly stale copy.
    try {
      await projectRequestsRepository.confirmKickoffGate({ id: requestId, gate });
    } catch (error) {
      if (error instanceof InvalidKickoffStateError) {
        return { success: false, error: STALE };
      }
      throw error;
    }

    // Key business event (after the commit).
    log.info('Kickoff gate confirmed', { requestId, relationshipId, gate, userId: user.id });

    revalidatePath(`/projects/${requestId}`);

    return { success: true, gate };
  } catch (error) {
    log.error('Failed to confirm kickoff gate', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
