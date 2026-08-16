'use server';

import 'server-only';

import { z } from 'zod';
import type * as Ably from 'ably';
import { conversationsRepository, projectRequestsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { isThreadOpenStatus } from '@/lib/project-request/conversation-view-types';
import { isRealtimeConfigured } from '@/lib/realtime/ably-server';
import { mintSubscribeOnlyToken } from '@/lib/realtime/mint-subscribe-token';
import { conversationChannelName } from '@/lib/realtime/channels';

const inputSchema = z.object({ requestId: z.uuid() });

export type CreateConversationRealtimeTokenResult =
  | { success: true; tokenRequest: Ably.TokenRequest }
  | { success: false; disabled?: true; error?: string };

/**
 * Ably token endpoint for the conversation island (BAL-271 / A4 — D1). A
 * Server Action, not an API route (CLAUDE.md rule). Issues SUBSCRIBE-ONLY
 * capabilities over an EXPLICIT channel list (no wildcards):
 *  - client lens → every OPEN thread of this (owned) request;
 *  - expert lens → their own relationship's channel, only if open;
 *  - admin/observer → denied (pure observer, no live chat in A4).
 * `clientId = user.id`; explicit 15-min TTL — ably-js re-invokes `authCallback`
 * on expiry, so entitlement staleness is bounded by `TOKEN_TTL_MS`.
 *
 * ⚠ BAL-424: entitlement is still resolved over RELATIONSHIPS (that is what the
 * request graph and the lens speak), but the granted channels are keyed on the
 * CONVERSATION each one anchors. Capabilities stay subscribe-only over an
 * explicit channel list — never a wildcard.
 */
export async function createConversationRealtimeTokenAction(
  input: z.infer<typeof inputSchema>
): Promise<CreateConversationRealtimeTokenResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      log.warn('Realtime token denied', { requestId, userId: user.id, reason: 'missing' });
      return { success: false, error: 'You do not have access to this conversation.' };
    }

    const ctx = resolveRequestLens(user, request);
    if (ctx?.archetype !== 'participant') {
      log.warn('Realtime token denied', {
        requestId,
        userId: user.id,
        lens: ctx?.lens ?? null,
      });
      return { success: false, error: 'You do not have access to this conversation.' };
    }

    const entitledRelationshipIds = request.relationships
      .filter((r) => isThreadOpenStatus(r.status))
      .filter((r) => ctx.lens !== 'expert' || r.id === ctx.relationshipId)
      .map((r) => r.id);

    if (entitledRelationshipIds.length === 0) {
      log.warn('Realtime token denied', {
        requestId,
        userId: user.id,
        lens: ctx.lens,
        reason: 'no open threads',
      });
      return { success: false, error: 'No open conversations on this request.' };
    }

    /**
     * ⚠⚠ THE `disabled` GATE STAYS **HERE**, AHEAD OF THE ENSURE BELOW, EVEN THOUGH
     * `mintSubscribeOnlyToken` RE-CHECKS IT. The ensure is a WRITE; running it in an
     * environment with no realtime transport at all (dev/CI) would mint conversation rows for
     * a token that is never issued. Ordering is behaviour here, not tidiness.
     */
    if (!isRealtimeConfigured()) {
      log.warn('Realtime disabled (no ABLY_API_KEY)', { requestId, userId: user.id });
      return { success: false, disabled: true };
    }

    /**
     * ⚠ ENSURE, NOT FIND (BAL-424). A thread whose conversation did not yet exist would
     * silently drop out of the capability list, and the first message posted to it would be
     * invisible to the counterparty until their token refreshed (≤ `TOKEN_TTL_MS`).
     * Idempotent — one row per thread, ever — and the write runs AFTER the participant lens
     * is proven, never before.
     */
    const conversationIdByRelationship = await conversationsRepository.ensureManyForContexts(
      entitledRelationshipIds.map((id) => ({ contextType: 'relationship' as const, contextId: id }))
    );

    // ⚠ BAL-437 — THE SHARED MINTING TAIL. Subscribe-only, explicit channels, one TTL.
    const minted = await mintSubscribeOnlyToken({
      clientId: user.id,
      channels: [...conversationIdByRelationship.values()].map(conversationChannelName),
    });
    if (!minted.success) {
      return { success: false, disabled: true };
    }

    return { success: true, tokenRequest: minted.tokenRequest };
  } catch (error) {
    log.error('Failed to create conversation realtime token', {
      requestId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not connect live updates.' };
  }
}
