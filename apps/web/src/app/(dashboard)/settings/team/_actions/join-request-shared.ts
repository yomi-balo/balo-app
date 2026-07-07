import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  partyJoinRequestsRepository,
  InvalidJoinRequestTransitionError,
  type PartyJoinRequest,
  type PartyType,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { hasCapability, CAPABILITIES, type CapabilityScope } from '@/lib/authz';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { emitJoinRequestResolved } from '@/lib/analytics/party-join';

/**
 * Shared, non-action helpers for the BAL-345 join-request Server Actions (approve /
 * decline / withdraw). This file has NO `'use server'` directive — it is a
 * `server-only` helper module co-located in `_actions/`, imported by the thin
 * action files. Keeping the load + gate + resolution-emit here once means
 * approve/decline never copy-paste the gate or the notification/analytics fan-out
 * (Sonar new-code duplication gate).
 */

export type ActionResult = { success: true } | { success: false; error: string };

/**
 * The capability scope for a request, branched on its OWN `partyType` (never
 * assumed) — a company request checks `{ companyId }`, an agency request checks
 * `{ agencyId }`. Always passing `{ companyId }` would fail-closed on agency
 * requests.
 */
export function partyScopeOf(request: { partyType: PartyType; partyId: string }): CapabilityScope {
  return request.partyType === 'company'
    ? { companyId: request.partyId }
    : { agencyId: request.partyId };
}

/** Whole seconds from request creation → resolution (never negative). */
export function resolutionSeconds(request: { createdAt: Date; resolvedAt: Date | null }): number {
  const resolved = request.resolvedAt ?? new Date();
  return Math.max(0, Math.round((resolved.getTime() - request.createdAt.getTime()) / 1000));
}

export type LoadRequestResult =
  | { ok: true; request: PartyJoinRequest }
  | { ok: false; error: string };

/**
 * Load a join request and gate the actor on `MANAGE_MEMBERS` for the request's
 * OWN party scope. Used by approve + decline (both admin-only). The gate reads the
 * actor's LIVE membership role via the `hasCapability` seam — the single place a
 * role is interpreted. Returns a friendly error on missing request or denial.
 */
export async function loadRequestForManage(
  requestId: string,
  actor: { id: string }
): Promise<LoadRequestResult> {
  const request = await partyJoinRequestsRepository.findById(requestId);
  if (request === undefined) {
    return { ok: false, error: 'This request could not be found.' };
  }
  const allowed = await hasCapability(actor, CAPABILITIES.MANAGE_MEMBERS, partyScopeOf(request));
  if (!allowed) {
    return { ok: false, error: 'You do not have permission to do this.' };
  }
  return { ok: true, request };
}

/**
 * Post-commit side-effects shared by approve + decline: notify the requester
 * (`self`) and track the resolution (distinct_id = the requester). Notification is
 * fire-and-forget; analytics fires via `trackServerAndFlush`. `userId` in the
 * payload is the requester (the subject) — the resolver hydrates `data.user` from
 * it and `recipient:'self'` resolves to it.
 */
export function emitJoinRequestResolution(
  request: PartyJoinRequest,
  resolution: 'approved' | 'declined'
): void {
  const payload = {
    correlationId: request.id,
    partyType: request.partyType,
    partyId: request.partyId,
    userId: request.userId,
  };
  if (resolution === 'approved') {
    publishNotificationEvent('party.join_request_approved', payload).catch(() => {
      // publishNotificationEvent logs internally.
    });
  } else {
    publishNotificationEvent('party.join_request_declined', payload).catch(() => {
      // publishNotificationEvent logs internally.
    });
  }
  emitJoinRequestResolved(resolution, {
    partyType: request.partyType,
    timeToResolutionSeconds: resolutionSeconds(request),
    requesterUserId: request.userId,
  });
}

const requestIdSchema = z.object({ requestId: z.uuid() });

/**
 * The shared approve/decline pipeline (BAL-345 §5.3). Both resolutions are
 * admin-only (`MANAGE_MEMBERS`) and identical except for the repo call and the
 * user-facing verb, so the auth + validation + gate + post-commit side-effect
 * skeleton lives here ONCE (Sonar new-code duplication gate). The thin
 * `'use server'` action files delegate to this with their resolution kind.
 */
export async function runJoinRequestResolution(
  input: { requestId: string },
  resolution: 'approved' | 'declined'
): Promise<ActionResult> {
  const verb = resolution === 'approved' ? 'approve' : 'decline';

  let session;
  try {
    session = await requireUser();
  } catch {
    return { success: false, error: 'You must be signed in to do this.' };
  }

  const parsed = requestIdSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  const gate = await loadRequestForManage(requestId, session);
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }

  try {
    const { request } =
      resolution === 'approved'
        ? await partyJoinRequestsRepository.approve({ requestId, actorUserId: session.id })
        : await partyJoinRequestsRepository.decline({ requestId, actorUserId: session.id });

    emitJoinRequestResolution(request, resolution);
    revalidatePath('/settings/team');
    return { success: true };
  } catch (error) {
    log.error(`Failed to ${verb} join request`, {
      requestId,
      actorUserId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (error instanceof InvalidJoinRequestTransitionError) {
      return { success: false, error: 'This request is no longer pending.' };
    }
    return { success: false, error: `Could not ${verb} this request. Please try again.` };
  }
}
