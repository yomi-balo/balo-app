'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { enterCallAction } from '@/lib/meetings/call-action-entry';
import { resolveMeetingChatAccess } from '@/lib/meetings/meeting-chat-anchor';
import { TYPING_SIGNALS } from '@/lib/realtime/channels';
import { relayTypingSignal } from '@/lib/realtime/relay-typing-signal';
import type { SendTypingSignalResult } from '@/lib/realtime/typing-relay';

const inputSchema = z.object({ meetingId: z.uuid(), signal: z.enum(TYPING_SIGNALS) }).strict();

/**
 * Relay one "typing…" signal from the in-call Chat panel into the call's thread — the server
 * publishes it; the client's token is subscribe-only (see `typingChannelName`).
 *
 * ⚠⚠ THE GATE IS `postMeetingMessageAction`'s, IN FULL: `resolveMeetingChatAccess` WITH its
 * writability read, an anchor, and `anchor.writable === true` (`null` means NOT resolved, never
 * "assume open"). Typing is conversation-grain, so it rides the thread's `typing:` channel —
 * never `meeting:{id}`.
 *
 * ⚠ A GUEST NEVER GETS HERE: `requireOnboardedUser()` refuses a guest session, exactly as the
 * token and post actions do.
 */
export async function sendMeetingTypingAction(
  input: z.infer<typeof inputSchema>
): Promise<SendTypingSignalResult> {
  const entry = await enterCallAction(() => requireOnboardedUser(), inputSchema, input);
  if (!entry.ok) return { success: false, error: entry.error };
  const { user } = entry;
  const { meetingId, signal } = entry.data;

  return relayTypingSignal({
    user,
    signal,
    logContext: { meetingId },
    resolvePostableConversationId: async () => {
      const access = await resolveMeetingChatAccess({
        meetingId,
        actor: { kind: 'member', userId: user.id },
      });
      if (!access.ok || access.anchor === null) return null;
      return access.anchor.writable === true ? access.anchor.conversationId : null;
    },
  });
}
