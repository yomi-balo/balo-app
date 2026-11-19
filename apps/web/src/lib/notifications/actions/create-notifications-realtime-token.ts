'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { mintSubscribeOnlyToken } from '@/lib/realtime/mint-subscribe-token';
import { notificationsChannelName } from '@/lib/realtime/channels';
import type { RealtimeTokenResult } from '@/lib/realtime/ably-auth';

/**
 * BAL-620 — the Ably token endpoint for the notification bell's push connection.
 *
 * ⚠ SUBSCRIBE-ONLY, OVER EXACTLY ONE EXPLICIT CHANNEL — `notifications:{session user id}`,
 * never a wildcard. The action takes NO input: the channel is named from the session alone, so
 * a tampered browser cannot ask for another user's channel. Only servers publish: the API sends
 * `notification.created`, and the web read routes send `notification.read` to the reader's own
 * channel.
 *
 * ⚠ THE SUBJECT IS THE SESSION ITSELF, so there is no tenancy gate and no capability axis to
 * resolve: a user may always listen to their own notification ping. The channel carries no
 * payload, so a subscriber learns nothing beyond "refetch".
 *
 * ⚠ `clientId = user.id`, so Ably itself attributes every connection to a real user. Ably re-runs
 * this action through `authCallback` every `TOKEN_TTL_MS`; once the session has ended the call
 * is refused and the bell falls back to polling.
 */
export async function createNotificationsRealtimeTokenAction(): Promise<RealtimeTokenResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  try {
    const minted = await mintSubscribeOnlyToken({
      clientId: user.id,
      channels: [notificationsChannelName(user.id)],
    });
    if (!minted.success) {
      log.warn('Realtime disabled (no ABLY_API_KEY)', { userId: user.id });
      return { success: false, disabled: true };
    }

    return { success: true, tokenRequest: minted.tokenRequest };
  } catch (error) {
    log.error('Failed to create notifications realtime token', {
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not connect live updates.' };
  }
}
