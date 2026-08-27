'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { callActionErrorFields, enterCallAction } from '@/lib/meetings/call-action-entry';
import { resolveMeetingChatAccess } from '@/lib/meetings/meeting-chat-anchor';
import { mintSubscribeOnlyToken } from '@/lib/realtime/mint-subscribe-token';
import { conversationChannelName, meetingChannelName } from '@/lib/realtime/channels';
import type { RealtimeTokenResult } from '@/lib/realtime/ably-auth';

const inputSchema = z.object({ meetingId: z.uuid() }).strict();

/**
 * BAL-437 — the Ably token endpoint for the IN-CALL surface.
 *
 * ⚠⚠ SUBSCRIBE-ONLY, EXPLICIT, NON-WILDCARD, OVER **AT MOST TWO** CHANNELS:
 *
 *   · `meeting:{meetingId}`           — always. Reactions and file invalidations.
 *   · `conversation:{conversationId}` — ONLY when the meeting resolves to a thread anchor.
 *
 * A meeting with no anchor gets ONE channel, not a placeholder and not a wildcard. That is the
 * whole reason the gate returns `anchor: null` rather than throwing.
 *
 * ⚠⚠ THE FULL TENANCY GATE RE-RUNS ON EVERY TOKEN REFRESH. ably-js re-invokes `authCallback`
 * on expiry, so a membership revoked mid-call is bounded by `TOKEN_TTL_MS` (15 min): the next
 * refresh is denied and the connection fails to *"Live updates are unavailable"*. Sends are
 * refused independently by the write actions, which do not wait for a token to expire.
 *
 * ⚠ `clientId = user.id`, so Ably itself attributes every connection to a real user.
 *
 * ⚠⚠ **NO MEMBER'S GRANT IS WIDENED TO MAKE ROOM FOR A FUTURE GUEST.** A guest satisfies
 * `requireOnboardedUser()` not at all and reaches no branch here; **BAL-445** opens that arm
 * with its own session primitive. Pre-granting anything now would be a live capability with no
 * live subject.
 */
export async function createMeetingRealtimeTokenAction(
  input: z.infer<typeof inputSchema>
): Promise<RealtimeTokenResult> {
  const entry = await enterCallAction(() => requireOnboardedUser(), inputSchema, input);
  if (!entry.ok) return { success: false, error: entry.error };
  const { user } = entry;
  const { meetingId } = entry.data;

  try {
    // ⚠ `withWritability: false` — THIS ACTION WANTS THE CHANNEL NAME, NEVER THE COMPOSER
    // VERDICT. It skips the engagement arm's lifecycle read (one indexed round trip saved on a
    // path that re-runs every 15 minutes per connected client). ⚠⚠ IT DOES **NOT** SKIP THE
    // RELATIONSHIP ARM'S STATUS READ, and must not: there, the status decides whether there is
    // an anchor at all, so skipping it would mint a `conversation:{id}` SUBSCRIBE grant for a
    // declined relationship's thread.
    const access = await resolveMeetingChatAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
      withWritability: false,
    });
    if (!access.ok) {
      // ⚠ ONE LITERAL. The gate already logged which shape it was.
      return { success: false, error: 'You do not have access to this call.' };
    }

    const channels = [meetingChannelName(meetingId)];
    if (access.anchor !== null) {
      channels.push(conversationChannelName(access.anchor.conversationId));
    }

    const minted = await mintSubscribeOnlyToken({ clientId: user.id, channels });
    if (!minted.success) {
      log.warn('Realtime disabled (no ABLY_API_KEY)', { meetingId, userId: user.id });
      return { success: false, disabled: true };
    }

    return { success: true, tokenRequest: minted.tokenRequest };
  } catch (error) {
    log.error('Failed to create meeting realtime token', {
      meetingId,
      userId: user.id,
      ...callActionErrorFields(error),
    });
    return { success: false, error: 'Could not connect live updates.' };
  }
}
