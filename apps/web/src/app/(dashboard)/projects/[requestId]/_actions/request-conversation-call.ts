'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

export type RequestConversationCallResult =
  | {
      success: true;
      /** Explicit: this is a stub, not a real booking. */
      mocked: true;
      confirmation: {
        message: string;
        /** Real value lands with the Booking project. */
        scheduledAtIso: null;
      };
    }
  | { success: false; error: string };

/**
 * ⚠️ MOCK SEAM — replaced by the future **Booking project**.
 *
 * The per-thread call CTA ("Book a call" / "Propose times"). This is a
 * DOWNSTREAM CONFIRMATION STUB and is FULLY DECOUPLED from the state machine:
 * it performs NO status transition, publishes NO notification, and writes
 * NOTHING (no calendar, no slot, no event, no message — BAL-212: nothing
 * auto-posts). It still runs the FULL auth/lens/relationship validation so the
 * seam swaps to the real booking action without changing call sites.
 *
 * When the Booking project lands, this action is replaced (same file, same
 * client call-site) by the real calendar action. File a "related" Linear issue
 * against this seam when that project is created. Mirrors `book-exploratory.ts`.
 */
export async function requestConversationCallAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestConversationCallResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You must be signed in to request a call.' };
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

    log.info('Conversation call requested (mock)', {
      requestId,
      relationshipId,
      userId: user.id,
      lens: access.ctx.lens,
    });

    const message =
      access.ctx.lens === 'expert'
        ? 'Times proposed — the client will be notified by email.'
        : 'Your call request is in — Balo will email you the details.';

    return {
      success: true,
      mocked: true,
      confirmation: { message, scheduledAtIso: null },
    };
  } catch (error) {
    log.error('Failed to request conversation call (mock)', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not request your call. Please try again.' };
  }
}
