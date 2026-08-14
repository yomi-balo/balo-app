'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { getAblyRest, isRealtimeConfigured } from '@/lib/realtime/ably-server';
import { conversationChannelName } from '@/lib/realtime/channels';
import type { ConversationRealtimeTokenResult } from '@/components/balo/conversation/use-conversation-realtime';

const inputSchema = z.object({ engagementId: z.uuid() }).strict();

/**
 * Explicit token TTL (ms): bounds how long a revoked participant can keep a live subscription
 * (vs Ably's 60-minute default). ably-js auto-renews through `authCallback`, which re-runs the
 * FULL gate below on every refresh — so entitlement staleness is bounded by this value.
 */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * BAL-421 — the Ably token endpoint for the CASE conversation island.
 *
 * ⚠ SUBSCRIBE-ONLY, OVER EXACTLY ONE EXPLICIT CHANNEL — never a wildcard. A case has exactly
 * one thread, so the capability list is the single `conversation:{conversationId}` the gate
 * resolved. (The project-request equivalent grants a LIST because a request fans out to many
 * experts; a case has one counterparty and one thread.)
 *
 * ⚠⚠ IT RESOLVES THE CONVERSATION FROM **THE GATE**, AND MUST NEVER MINT ONE. The
 * project-request token action deliberately calls `ensureManyForContexts` (a WRITE) because a
 * request's thread may not exist yet when an expert is first invited. A CASE's thread is
 * provisioned in the SAME TRANSACTION as the case itself (`caseEngagementsRepository.create`),
 * so there is nothing to ensure — and minting a row from a token-issuing path would be the
 * transitive-write defect BAL-424 closed. `resolveCaseAccess` reaches `findByContext` only.
 *
 * ⚠ NO WRITABILITY CHECK. A CLOSED case's thread is still SUBSCRIBED to — the token grants
 * `subscribe`, never `publish`, so a read-only thread and a live one need the same grant.
 * Posting is refused by `postCaseMessageAction`, which is the only writer.
 *
 * ⚠ `clientId = user.id`, so Ably itself attributes every connection to a real user.
 */
export async function createCaseRealtimeTokenAction(
  input: z.infer<typeof inputSchema>
): Promise<ConversationRealtimeTokenResult> {
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
  const { engagementId } = parsed.data;

  try {
    // ⚠ THE FULL TENANCY GATE, RE-RUN ON EVERY TOKEN REFRESH. This is what makes
    // `TOKEN_TTL_MS` a real bound on a revoked member's live subscription rather than a
    // decorative number.
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      log.warn('Case realtime token denied', { engagementId, userId: user.id });
      return { success: false, error: 'You do not have access to this conversation.' };
    }

    if (!isRealtimeConfigured()) {
      log.warn('Realtime disabled (no ABLY_API_KEY)', { engagementId, userId: user.id });
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
      capability: JSON.stringify({
        [conversationChannelName(access.conversationId)]: ['subscribe'],
      }),
    });

    return { success: true, tokenRequest };
  } catch (error) {
    log.error('Failed to create case realtime token', {
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not connect live updates.' };
  }
}
