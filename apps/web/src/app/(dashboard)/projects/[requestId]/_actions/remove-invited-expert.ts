'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requestExpertRelationshipsRepository } from '@balo/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { log } from '@/lib/logging';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

export type RemoveInvitedExpertResult = { success: true } | { success: false; error: string };

/**
 * Admin triage — remove an invited (pre-EOI) expert via SOFT DELETE.
 *
 * There is no `removed`/`withdrawn` relationship status; soft-deleting the row is
 * the A2 move. The removed expert then disappears from `findByIdWithRelations` /
 * `listByRequest` (both filter `deletedAt IS NULL`) and loses participant access
 * (the lens resolver only matches live relationships). Removal is allowed ONLY
 * while the relationship is still `invited` — once an EOI is in, the row is locked.
 */
export async function removeInvitedExpertAction(
  input: z.infer<typeof inputSchema>
): Promise<RemoveInvitedExpertResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { success: false, error: 'You do not have permission to do this.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const relationship = await requestExpertRelationshipsRepository.findById(relationshipId);
    if (
      relationship === undefined ||
      relationship.projectRequestId !== requestId ||
      relationship.status !== 'invited'
    ) {
      return { success: false, error: 'This expert can no longer be removed.' };
    }

    await requestExpertRelationshipsRepository.softDelete(relationshipId);

    log.info('Invited expert removed', { requestId, relationshipId, adminUserId: admin.id });

    revalidatePath(`/projects/${requestId}`);
    return { success: true };
  } catch (error) {
    log.error('Failed to remove invited expert', {
      requestId,
      relationshipId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not remove this expert. Please try again.' };
  }
}
