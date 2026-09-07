'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, usersRepository } from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { runAssignOwnerFanout } from './_shared/assign-owner-fanout';

const inputSchema = z.object({ requestId: z.uuid(), ownerUserId: z.uuid().nullable() }).strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const REQUEST_GONE = 'This request no longer exists.';
const NOT_STAFF = 'That person is not a Balo staff member.';
const GENERIC_FAILURE = 'Could not update the Balo owner. Please try again.';
const UNKNOWN_STAFF_NAME = 'A team member';

export type AssignRequestOwnerActionResult =
  | {
      success: true;
      owner: { userId: string; name: string } | null;
      changed: boolean;
      analytics: { requestId: string; previousOwnerPresent: boolean; selfAssigned: boolean };
    }
  | { success: false; error: string; code?: 'denied' | 'gone' | 'not_staff' };

/** Resolve the display name behind a (possibly null) owner id. `null` in ⇒ `null` out. */
async function resolveOwnerDisplay(
  ownerUserId: string | null
): Promise<{ userId: string; name: string } | null> {
  if (ownerUserId === null) return null;
  const [row] = await usersRepository.findNamesByIds([ownerUserId]);
  return {
    userId: ownerUserId,
    name:
      row === undefined
        ? UNKNOWN_STAFF_NAME
        : personDisplayName(row.firstName, row.lastName, UNKNOWN_STAFF_NAME),
  };
}

/**
 * Assign (or clear, or reassign) a request's Balo owner (BAL-541). Gated on the platform
 * capability `ASSIGN_ANY_REQUEST_OWNER` (D1/D7) — the shape is `close-request-as-admin.ts`'s
 * (`requireOnboardedUser` in try/catch, then `hasPlatformCapability`), NOT `requireAdmin()`.
 *
 * Clearing (`ownerUserId: null`) is the SAME act as assigning — one column, one audit action,
 * three affordances (D7's docblock). The repository enforces staff eligibility in-transaction;
 * this action never re-derives or re-checks a role itself.
 */
export async function assignRequestOwnerAction(
  input: z.infer<typeof inputSchema>
): Promise<AssignRequestOwnerActionResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER)) {
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, ownerUserId } = parsed.data;

  try {
    // `findByIdWithRelations`, not the plain `findById` — the fan-out needs
    // `request.company.name` for the notification body, the `close-request-as-admin.ts`
    // precedent. Read lives INSIDE the try (`override-balo-fee.ts` precedent) — a DB
    // rejection here must land in the catch below, not escape as an unhandled rejection.
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: REQUEST_GONE, code: 'gone' };
    }

    const result = await projectRequestsRepository.assignOwner({
      requestId,
      ownerUserId,
      actorUserId: user.id,
    });

    if (result.outcome === 'not_staff' || result.outcome === 'owner_not_found') {
      // Same message for both — a candidate that doesn't exist and a candidate that isn't
      // staff must not be distinguishable from the response (no user-existence leak).
      log.warn('Balo owner assignment refused', {
        requestId,
        actorUserId: user.id,
        outcome: result.outcome,
      });
      return { success: false, error: NOT_STAFF, code: 'not_staff' };
    }

    if (result.outcome === 'unchanged') {
      const owner = await resolveOwnerDisplay(result.ownerUserId);
      return {
        success: true,
        owner,
        changed: false,
        analytics: {
          requestId,
          previousOwnerPresent: result.ownerUserId !== null,
          selfAssigned: result.ownerUserId === user.id,
        },
      };
    }

    // outcome === 'assigned'
    log.info('Balo owner assigned', {
      requestId,
      actorUserId: user.id,
      previousOwnerUserId: result.previousOwnerUserId,
      ownerUserId: result.ownerUserId,
      cleared: result.ownerUserId === null,
    });

    if (result.ownerUserId !== null) {
      runAssignOwnerFanout({
        correlationId: result.auditId,
        projectRequestId: requestId,
        newOwnerUserId: result.ownerUserId,
        assignedByUserId: user.id,
        title: request.title,
        clientCompanyName: request.company.name,
      });
    }

    const owner = await resolveOwnerDisplay(result.ownerUserId);

    revalidatePath(`/projects/${requestId}`);
    revalidatePath('/projects');

    return {
      success: true,
      owner,
      changed: true,
      analytics: {
        requestId,
        previousOwnerPresent: result.previousOwnerUserId !== null,
        selfAssigned: result.ownerUserId === user.id,
      },
    };
  } catch (error) {
    log.error('Failed to assign Balo owner', {
      requestId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
