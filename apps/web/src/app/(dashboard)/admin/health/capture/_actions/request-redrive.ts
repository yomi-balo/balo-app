'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { requestAdminRedrive } from '@/lib/api/admin-redrive';
import { requestRedriveSchema, type RequestRedriveResult } from './capture-health-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
const INVALID_INPUT = 'That re-drive request is not valid.';
const NOT_REDRIVABLE = 'This row already moved — refresh the page to see its current state.';
const ENQUEUE_FAILED =
  'The re-drive was recorded but could not be queued. An engineer has been notified.';
const UNAVAILABLE = 'Could not re-drive right now. Try again in a moment.';

/**
 * BAL-550 (§7.7) — the ONE mutation this lens can cause. `requireOnboardedUser()` — a mutating
 * web action must use the onboarded gate (memory
 * `reference_web_mutating_server_action_requires_onboarded_user`); middleware does not protect
 * Server Actions.
 *
 * The `hasPlatformCapability` check here is the FAIL-CLOSED FIRST gate; the api's own check
 * against the LIVE row (`GET /admin/redrive/:kind/:id`'s `usersRepository.findById`) is the
 * REAL one — this is defence-in-depth, not the authorization boundary.
 *
 * `apps/web` imports NO bullmq and NO Redis here — `lib/api/admin-redrive.ts` is a Bearer-hop
 * fetch to `apps/api`, never a direct queue call (pinned by
 * `invariants/web-actions-never-import-bullmq.test.ts`).
 */
export async function requestRedrive(input: {
  kind: string;
  entityId: string;
}): Promise<RequestRedriveResult> {
  const user = await requireOnboardedUser();
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.REDRIVE_JOB)) {
    return { success: false, reason: 'forbidden', error: PERMISSION_DENIED };
  }

  const parsed = requestRedriveSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: 'invalid', error: INVALID_INPUT };
  }
  const { kind, entityId } = parsed.data;

  try {
    const outcome = await requestAdminRedrive(kind, entityId);

    if (outcome.ok) {
      log.info('Admin re-drive requested', { kind, entityId, jobId: outcome.result.jobId });
      return { success: true, jobId: outcome.result.jobId };
    }

    switch (outcome.reason) {
      case 'forbidden':
        return { success: false, reason: 'forbidden', error: PERMISSION_DENIED };
      case 'not_redrivable':
        return { success: false, reason: 'not_redrivable', error: NOT_REDRIVABLE };
      case 'enqueue_failed':
        return { success: false, reason: 'enqueue_failed', error: ENQUEUE_FAILED };
      case 'unavailable':
        return { success: false, reason: 'unavailable', error: UNAVAILABLE };
      default: {
        // `outcome` is ONE object whose `reason` is a union, not a union of objects, so the
        // exhaustiveness assertion has to sit on the property rather than on `outcome` itself.
        const exhaustive: never = outcome.reason;
        log.error('Unhandled admin re-drive refusal', { kind, entityId, reason: exhaustive });
        return { success: false, reason: 'unavailable', error: UNAVAILABLE };
      }
    }
  } catch (error) {
    log.error('Failed to request an admin re-drive', {
      actorUserId: user.id,
      kind,
      entityId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, reason: 'unavailable', error: UNAVAILABLE };
  }
}
