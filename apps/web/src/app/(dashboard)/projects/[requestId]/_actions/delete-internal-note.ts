'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { internalNotesRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';

const inputSchema = z.object({ requestId: z.uuid(), noteId: z.uuid() }).strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const NOTE_GONE = 'That note is no longer there.';
const GENERIC_FAILURE = 'Could not delete the note. Please try again.';

export type DeleteInternalNoteActionResult =
  | { success: true; noteId: string }
  | { success: false; error: string; code?: 'denied' | 'gone' };

/**
 * Soft-delete a staff-internal note (BAL-541). Gated on the BASE platform capability
 * `MANAGE_INTERNAL_NOTES` (an author deleting their own note needs no more than that — D2);
 * `allowAnyAuthor` is then derived from a SECOND capability, `DELETE_ANY_INTERNAL_NOTE`
 * (`super_admin` ONLY), and handed to the repository as an already-resolved boolean — this
 * action never reads or compares a `platformRole` itself.
 *
 * ⚠ THIS IS THE ONE ACTION THAT CALLS `hasPlatformCapability` TWICE, DELIBERATELY — once for
 * the base gate, once to resolve `allowAnyAuthor`. The BAL-541 capability-gated invariant test
 * allows ≥1 call for exactly this reason (do not "fix" it down to one).
 */
export async function deleteInternalNoteAction(
  input: z.infer<typeof inputSchema>
): Promise<DeleteInternalNoteActionResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES)) {
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, noteId } = parsed.data;

  const allowAnyAuthor = hasPlatformCapability(
    user,
    PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE
  );

  try {
    const result = await internalNotesRepository.softDelete({
      noteId,
      actorUserId: user.id,
      allowAnyAuthor,
      expectedEntity: { entityType: 'project_request', entityId: requestId },
    });

    if (result.outcome === 'not_found') {
      return { success: false, error: NOTE_GONE, code: 'gone' };
    }

    if (result.outcome === 'forbidden') {
      return { success: false, error: PERMISSION_DENIED, code: 'denied' };
    }

    log.info('Internal note deleted', {
      requestId,
      actorUserId: user.id,
      noteId: result.noteId,
      allowAnyAuthor,
    });

    revalidatePath(`/projects/${requestId}`);

    return { success: true, noteId: result.noteId };
  } catch (error) {
    log.error('Failed to delete internal note', {
      requestId,
      noteId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
