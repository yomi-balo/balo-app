'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, internalNotesRepository } from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import type { InternalNoteView } from '@/lib/project-request/load-balo-panel';
import { deriveInitials } from '@/lib/format/initials';

const inputSchema = z
  .object({
    requestId: z.uuid(),
    // min 3 mirrors the design reference's composer gate (`request-close.jsx:1179`,
    // `disabled={draft.trim().length < 3}`); max 2000 matches BAL-540's staff-note cap
    // (`close-request-as-admin.ts:22`). Length lives HERE — `@balo/db` has no drizzle-zod.
    body: z.string().trim().min(3).max(2000),
  })
  .strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const REQUEST_GONE = 'This request no longer exists.';
const GENERIC_FAILURE = 'Could not add the note. Please try again.';

export type CreateInternalNoteActionResult =
  | {
      success: true;
      note: InternalNoteView;
      analytics: { entityType: 'project_request'; entityId: string };
    }
  | { success: false; error: string; code?: 'denied' | 'gone' };

/**
 * Append a staff-internal note to a project request (BAL-541). Gated on the platform
 * capability `MANAGE_INTERNAL_NOTES` (D1) — the `close-request-as-admin.ts` shape
 * (`requireOnboardedUser` in try/catch, then `hasPlatformCapability`), NOT `requireAdmin()`.
 *
 * ⚠ `entityType` is a SERVER-STATED LITERAL, never a request-body field — the Zod schema has
 * NO key for it (`.strict()` rejects one if a caller tried), matching `meeting_files.party` /
 * `request_shared_files`'s rule. The parent request's liveness is proved by `findById` BEFORE
 * the insert — `internal_notes.entity_id` has no foreign key (it is polymorphic).
 *
 * ⚠ `body` NEVER appears in the log line — not even its length, one step stricter than the
 * `close_note` precedent.
 */
export async function createInternalNoteAction(
  input: z.infer<typeof inputSchema>
): Promise<CreateInternalNoteActionResult> {
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
  const { requestId, body } = parsed.data;

  const request = await projectRequestsRepository.findById(requestId);
  if (request === undefined) {
    return { success: false, error: REQUEST_GONE, code: 'gone' };
  }

  try {
    const { note } = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: requestId,
      body,
      authorUserId: user.id,
    });

    // ⚠ NEVER `body`, never a length that could fingerprint it.
    log.info('Internal note created', { requestId, actorUserId: user.id, noteId: note.id });

    const authorName = personDisplayName(user.firstName, user.lastName, 'A team member');

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      note: {
        id: note.id,
        authorName,
        authorInitials: deriveInitials(authorName),
        body: note.body,
        createdAtIso: note.createdAt.toISOString(),
        canDelete: true, // the author, freshly written — always deletable by its own author
      },
      analytics: { entityType: 'project_request', entityId: requestId },
    };
  } catch (error) {
    log.error('Failed to create internal note', {
      requestId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
