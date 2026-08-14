'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import type { MarkCaseThreadReadResult } from './_types/case-action-types';

const inputSchema = z.object({ engagementId: z.uuid() }).strict();

/**
 * BAL-421 — advance the viewer's read watermark for a case thread.
 *
 * The repository upsert uses `GREATEST(existing, new)`, so concurrent or out-of-order marks
 * never move the watermark backwards.
 *
 * ⚠ IT WRITES (`conversation_read_states`), so it gates on `requireOnboardedUser()` and must
 * NOT be added to `READ_ONLY_ALLOWLIST` — that allowlist is for actions authenticating with a
 * bare `requireUser(`, and an entry here would fail its own no-stale-entries test.
 *
 * ⚠ NO WRITABILITY CHECK. Marking a CLOSED case's thread read is correct and expected — the
 * thread stays readable forever, and a viewer who reads it has read it.
 *
 * High-frequency: no `log.info` (it is not a business event) and no `revalidatePath` (the
 * unread state is island-local).
 */
export async function markCaseThreadReadAction(
  input: z.infer<typeof inputSchema>
): Promise<MarkCaseThreadReadResult> {
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
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      return { success: false, error: 'This case is no longer available.' };
    }

    const state = await conversationsRepository.markThreadRead({
      conversationId: access.conversationId,
      userId: user.id,
      at: new Date(),
    });

    return { success: true, lastReadAtIso: state.lastReadAt.toISOString() };
  } catch (error) {
    log.error('Failed to mark case conversation thread read', {
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not update the thread. Please try again.' };
  }
}
