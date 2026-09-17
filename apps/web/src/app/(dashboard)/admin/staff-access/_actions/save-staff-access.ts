'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { usersRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { requireStaffAccessManager } from './_shared/require-staff-access-manager';
import {
  saveStaffAccessInputSchema,
  type SaveStaffAccessActionInput,
} from '../_lib/staff-access-schema';
import {
  STAFF_ACCESS_SAVE_MESSAGES,
  type SaveStaffAccessActionResult,
  type StaffAccessFailureCode,
} from '../_lib/staff-access-outcome';

/**
 * BAL-561 — save one person's Staff access: their platform role and their custom capability list
 * together, in `usersRepository.saveStaffAccess`'s ONE transaction. This action is the ONLY
 * caller from `apps/web`: the gate resolves `MANAGE_STAFF_CAPABILITIES` BEFORE parsing (no
 * existence leak on malformed input from a caller who could never open the page), and the
 * transaction itself re-checks the actor on its LOCKED row (M2/D6), refuses a self-edit and a
 * stale before-state (D6), and enforces the staff-management floor (D2). This action never
 * duplicates any of those rules — it only maps the repository's typed outcome to copy.
 *
 * No `publishNotificationEvent` (ruling 4 — Staff access changes are not notified) and no
 * analytics (out of scope on this ticket).
 */
export async function saveStaffAccessAction(
  input: SaveStaffAccessActionInput
): Promise<SaveStaffAccessActionResult> {
  const auth = await requireStaffAccessManager();
  if (!auth.ok) {
    return { success: false, code: 'denied', error: auth.error };
  }

  const parsed = saveStaffAccessInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid', error: STAFF_ACCESS_SAVE_MESSAGES.invalid };
  }
  const { targetUserId, expected, next } = parsed.data;

  try {
    const result = await usersRepository.saveStaffAccess({
      actorUserId: auth.user.id,
      targetUserId,
      expected,
      next,
    });

    if (result.outcome === 'refused') {
      log.warn('Staff access save refused', {
        actorUserId: auth.user.id,
        targetUserId,
        reason: result.reason,
      });
      // `actor_not_authorized` maps to the same generic denial every other arm of this action
      // uses — an actor whose LIVE row lost the token between the gate and the transaction is
      // not a "wrong request", it is the same "you cannot do this" the gate itself would say.
      const code: StaffAccessFailureCode =
        result.reason === 'actor_not_authorized' ? 'denied' : result.reason;
      return { success: false, code, error: STAFF_ACCESS_SAVE_MESSAGES[code] };
    }

    log.info('Staff access changed', {
      actorUserId: auth.user.id,
      targetUserId,
      roleChanged: result.roleChanged,
      customListChanged: result.customListChanged,
      auditEventIds: result.auditEventIds,
    });

    revalidatePath('/admin/staff-access');

    return {
      success: true,
      roleChanged: result.roleChanged,
      customListChanged: result.customListChanged,
    };
  } catch (error) {
    log.error('Staff access save failed', {
      actorUserId: auth.user.id,
      targetUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'failed', error: STAFF_ACCESS_SAVE_MESSAGES.failed };
  }
}
