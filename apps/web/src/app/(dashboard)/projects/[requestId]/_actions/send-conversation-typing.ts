'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { readConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { TYPING_SIGNALS } from '@/lib/realtime/channels';
import { relayTypingSignal } from '@/lib/realtime/relay-typing-signal';
import type { SendTypingSignalResult } from '@/lib/realtime/typing-relay';

const inputSchema = z
  .object({ requestId: z.uuid(), relationshipId: z.uuid(), signal: z.enum(TYPING_SIGNALS) })
  .strict();

/**
 * Relay one "typing…" signal into a project-request thread — the server publishes it; the
 * client's token is subscribe-only (see `typingChannelName`).
 *
 * ⚠⚠ THE GATE IS `postConversationMessageAction`'s AUTHORIZATION, BYTE FOR BYTE:
 * `readConversationAccess` runs the same `authorizeThread` core as `resolveConversationAccess`
 * (request exists, participant lens, an expert only on their OWN relationship, thread open). The
 * `relationshipId` is a CLAIM validated there, never trusted.
 *
 * ⚠ THE READ-ONLY VARIANT, ON PURPOSE. The writing variant get-or-creates the conversation; a
 * typing signal must never mint a row. An unprovisioned thread has no subscribers anyway, so it
 * is refused like any other denial.
 *
 * ⚠ THE COST, STATED: `authorizeThread` loads the whole request graph
 * (`projectRequestsRepository.findByIdWithRelations`, growing with every invited expert) — sized
 * for one call per MESSAGE, and paid here at typing frequency (10–15 calls per message). It is
 * the price of one definition of "may post"; a narrower read with the same decision would need a
 * parity test against `authorizeThread` to stay honest. The client's relay backs off after a slow
 * call, so a struggling database sheds typing first. The shared rate limit (BAL-461,
 * `relay-typing-signal.ts`'s `typing-signal` bucket) now bounds the call rate BEFORE this heavy
 * gate runs, so a throttled caller never pays this cost at all.
 */
export async function sendConversationTypingAction(
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
  const { requestId, relationshipId, signal } = parsed.data;
  const sessionUser = user;

  return relayTypingSignal({
    user,
    signal,
    logContext: { requestId, relationshipId },
    resolvePostableConversationId: async () => {
      const access = await readConversationAccess(sessionUser, requestId, relationshipId);
      return access.ok ? (access.conversationId ?? null) : null;
    },
  });
}
