'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

export type MarkThreadReadResult =
  | { success: true; lastReadAtIso: string }
  | { success: false; error: string };

/**
 * Advance the viewer's read watermark for one thread (BAL-271 / A4 — D3).
 * The repo upsert uses `GREATEST(existing, new)`, so concurrent/out-of-order
 * marks never move the watermark backwards. High-frequency — no `log.info`
 * (not a business event) and no `revalidatePath` (island-local state).
 */
export async function markThreadReadAction(
  input: z.infer<typeof inputSchema>
): Promise<MarkThreadReadResult> {
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
  const { requestId, relationshipId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    const state = await conversationsRepository.markThreadRead({
      relationshipId,
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
