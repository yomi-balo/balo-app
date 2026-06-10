'use server';

import 'server-only';

import { z } from 'zod';
import type * as Ably from 'ably';
import { projectRequestsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { isThreadOpenStatus } from '@/lib/project-request/conversation-view-types';
import { getAblyRest, isRealtimeConfigured } from '@/lib/realtime/ably-server';
import { conversationChannelName } from '@/lib/realtime/channels';

const inputSchema = z.object({ requestId: z.uuid() });

/**
 * Explicit token TTL (ms): bounds how long a revoked participant can keep a
 * live subscription (vs Ably's 60-min default). ably-js auto-renews through
 * `authCallback`, which re-validates entitlement on every refresh.
 */
const TOKEN_TTL_MS = 15 * 60 * 1000;

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
 */
export async function createConversationRealtimeTokenAction(
  input: z.infer<typeof inputSchema>
): Promise<CreateConversationRealtimeTokenResult> {
  let user;
  try {
    user = await requireUser();
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
    if (ctx === null || ctx.archetype !== 'participant') {
      log.warn('Realtime token denied', {
        requestId,
        userId: user.id,
        lens: ctx?.lens ?? null,
      });
      return { success: false, error: 'You do not have access to this conversation.' };
    }

    const entitledIds = request.relationships
      .filter((r) => isThreadOpenStatus(r.status))
      .filter((r) => ctx.lens !== 'expert' || r.id === ctx.relationshipId)
      .map((r) => r.id);

    if (entitledIds.length === 0) {
      log.warn('Realtime token denied', {
        requestId,
        userId: user.id,
        lens: ctx.lens,
        reason: 'no open threads',
      });
      return { success: false, error: 'No open conversations on this request.' };
    }

    if (!isRealtimeConfigured()) {
      log.warn('Realtime disabled (no ABLY_API_KEY)', { requestId, userId: user.id });
      return { success: false, disabled: true };
    }

    const rest = getAblyRest();
    if (rest === null) {
      // Unreachable after the isRealtimeConfigured() gate; defensive.
      return { success: false, disabled: true };
    }

    const tokenRequest = await rest.auth.createTokenRequest({
      clientId: user.id,
      ttl: TOKEN_TTL_MS,
      capability: JSON.stringify(
        Object.fromEntries(entitledIds.map((id) => [conversationChannelName(id), ['subscribe']]))
      ),
    });

    return { success: true, tokenRequest };
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
