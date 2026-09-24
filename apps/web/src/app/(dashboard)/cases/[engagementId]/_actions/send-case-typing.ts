'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { TYPING_SIGNALS } from '@/lib/realtime/channels';
import { relayTypingSignal } from '@/lib/realtime/relay-typing-signal';
import type { SendTypingSignalResult } from '@/lib/realtime/typing-relay';

const inputSchema = z.object({ engagementId: z.uuid(), signal: z.enum(TYPING_SIGNALS) }).strict();

/**
 * Relay one "typing…" signal into a CASE's thread — the server publishes it; the client's token
 * is subscribe-only (see `typingChannelName`).
 *
 * ⚠⚠ THE GATE IS `postCaseMessageAction`'s, IN FULL: `resolveCaseAccess` AND
 * `conversationWritable`. A closed case's thread is still readable, but nobody may post to it,
 * so nobody may signal typing on it either. The conversation id comes from the gate, never from
 * input, and the published identity is the session user's.
 */
export async function sendCaseTypingAction(
  input: z.infer<typeof inputSchema>
): Promise<SendTypingSignalResult> {
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
  const { engagementId, signal } = parsed.data;
  const userId = user.id;

  return relayTypingSignal({
    user,
    signal,
    logContext: { engagementId },
    resolvePostableConversationId: async () => {
      const access = await resolveCaseAccess(engagementId, userId);
      return access?.conversationWritable === true ? access.conversationId : null;
    },
  });
}
