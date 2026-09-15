import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

export type MarkThreadReadInput = z.infer<typeof inputSchema>;

export type MarkThreadReadResult =
  | { success: true; lastReadAtIso: string }
  | { success: false; error: string };

export async function runMarkThreadRead(
  user: SessionUser,
  input: MarkThreadReadInput
): Promise<MarkThreadReadResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    const state = await conversationsRepository.markThreadRead({
      conversationId: access.conversationId,
      userId: user.id,
      at: new Date(),
    });

    return { success: true, lastReadAtIso: state.lastReadAt.toISOString() };
  } catch (error) {
    log.error('Failed to mark conversation thread read', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not update the thread. Please try again.' };
  }
}
