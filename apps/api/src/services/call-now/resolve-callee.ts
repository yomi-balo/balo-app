/**
 * BAL-649 (decisions 7 & 10) — WHO GETS RUNG.
 *
 * · A CLIENT caller rings the delivering expert: `expertSettings.userId`, in the expert's own
 *   time zone.
 * · An EXPERT caller rings the client-side booker. A case has no "booker" column, so that person
 *   is the actor of the case's `engagement.created` audit row (written by the booking itself).
 *   A `NULL` actor (a seeded case) or a booker who no longer holds `participate` on the company
 *   resolves to NO callee — there is deliberately no fallback to another member (decision 10).
 *
 * ⚠ THE RESULT IS STORED ON THE RING (`callee_user_id`), so a later membership change cannot
 * re-point a ring that is already sounding.
 */
import {
  auditEventsRepository,
  partyMembershipsRepository,
  usersRepository,
  type CaseEngagementRow,
} from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import type { CallSide } from '@balo/shared/meetings';

const log = createLogger('call-now-callee');

/** Why no callee could be resolved. A LOG field, never a wire value. */
export type CalleeUnresolvedReason = 'no_actor' | 'departed' | 'self';

export type ResolveCalleeResult =
  | { ok: true; userId: string; timeZone: string }
  | { ok: false; reason: CalleeUnresolvedReason };

export interface ResolveCalleeInput {
  caseRow: CaseEngagementRow;
  side: CallSide;
  callerUserId: string;
  /** The delivering expert's settings, from `expertsRepository.findResolverSettings`. */
  expertSettings: { userId: string; timezone: string };
}

function unresolved(
  input: ResolveCalleeInput,
  reason: CalleeUnresolvedReason
): ResolveCalleeResult {
  log.warn(
    { engagementId: input.caseRow.id, callerUserId: input.callerUserId, side: input.side, reason },
    'Call now callee could not be resolved'
  );
  return { ok: false, reason };
}

async function resolveBooker(input: ResolveCalleeInput): Promise<ResolveCalleeResult> {
  const created = await auditEventsRepository.findLatestByEntityAndAction({
    entityType: 'engagement',
    entityId: input.caseRow.id,
    action: 'engagement.created',
  });
  const bookerUserId = created?.actorUserId ?? null;
  if (bookerUserId === null) {
    return unresolved(input, 'no_actor');
  }

  const role = await partyMembershipsRepository.getMemberRole(
    'company',
    input.caseRow.companyId,
    bookerUserId
  );
  if (role === undefined || !roleHasCapability(role, CAPABILITIES.PARTICIPATE)) {
    return unresolved(input, 'departed');
  }

  const context = await usersRepository.findTimezoneContext(bookerUserId, undefined);
  return { ok: true, userId: bookerUserId, timeZone: context?.savedTimezone ?? 'UTC' };
}

export async function resolveCallee(input: ResolveCalleeInput): Promise<ResolveCalleeResult> {
  const resolved: ResolveCalleeResult =
    input.side === 'client'
      ? { ok: true, userId: input.expertSettings.userId, timeZone: input.expertSettings.timezone }
      : await resolveBooker(input);

  if (resolved.ok && resolved.userId === input.callerUserId) {
    return unresolved(input, 'self');
  }
  return resolved;
}
