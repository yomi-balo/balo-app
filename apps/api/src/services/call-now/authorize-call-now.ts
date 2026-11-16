/**
 * BAL-649 (ADR-1058, decisions 6 & AC11) — WHO MAY RING ON A CASE, AND ON WHICH SIDE.
 *
 * The client arm is MEMBERSHIP (`participate` on the case's company); the expert arm is
 * ENGAGEMENT (`host_meetings` on the case). Two different subjects on two different axes —
 * neither is widened to cover the other, and no role string, lens or `activeMode` is read here.
 *
 * ⚠ ONE DENIAL LITERAL. There is no `forbidden`: an unknown case, a non-member and a member with
 * no capability all answer `case_not_found`, so the route is no existence oracle over case ids.
 *
 * ⚠ THE CASE'S OPEN/CLOSED STATE IS NOT READ HERE. A closed case is a GATE (`case_closed` in the
 * availability chain), not authority: a member of a closed case is still a member, and the read
 * view must still be able to say "not available".
 *
 * ⚠ THE EXPERT ARM IS SAFE ON A CLIENT-SUPPLIED `engagementId` ONLY BECAUSE STEP 1 ALREADY
 * RESOLVED THE OWNING PARTY FROM THE CASE'S OWN ROW — the tenancy obligation
 * `resolveHostContext`'s header assigns to its callers. The expert arm runs only for a user with
 * NO company role (the client arm wins, mirroring `participation.ts`).
 *
 * ⚠ ON THE EXPERT SIDE ONLY THE DELIVERING EXPERT MAY RING (`mayRing`). `host_meetings` is the
 * capability check and is also held by the expert's agency owner/admin, who join as OBSERVERS — a
 * ring they placed could never connect. So the expert arm ALSO requires an identity match: the
 * caller is the engagement's `expert_profiles.user_id`. Not a role comparison. An agency
 * owner/admin is still authorized to SEE the case's Call now view (`ok: true`), with
 * `mayRing: false`, which the gates turn into a hidden action (`callee_unavailable`, reason null).
 */
import { caseEngagementsRepository, expertsRepository, partyMembershipsRepository } from '@balo/db';
import type { CaseEngagementRow } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { CAPABILITIES, ENGAGEMENT_CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import type { CallSide } from '@balo/shared/meetings';
import { hasEngagementCapability } from '../meetings/authorize-engagement-host.js';

const log = createLogger('call-now-authz');

export type AuthorizeCallNowResult =
  | {
      ok: true;
      side: CallSide;
      caseRow: CaseEngagementRow;
      /** `false` for an expert-side holder who is not the delivering expert: may view, may not ring. */
      mayRing: boolean;
    }
  | { ok: false; code: 'case_not_found' };

export interface AuthorizeCallNowInput {
  engagementId: string;
  userId: string;
}

/** A LOG field, never a wire value. */
type DenialReason = 'no_case' | 'no_capability' | 'not_a_party';

function deny(
  input: AuthorizeCallNowInput,
  reason: DenialReason,
  extra: Record<string, unknown> = {}
): AuthorizeCallNowResult {
  log.warn(
    { engagementId: input.engagementId, userId: input.userId, reason, ...extra },
    'Call now denied'
  );
  return { ok: false, code: 'case_not_found' };
}

export async function authorizeCallNow(
  input: AuthorizeCallNowInput
): Promise<AuthorizeCallNowResult> {
  const { engagementId, userId } = input;

  const caseRow = await caseEngagementsRepository.findByEngagementId(engagementId);
  if (caseRow === undefined) {
    return deny(input, 'no_case');
  }

  const role = await partyMembershipsRepository.getMemberRole('company', caseRow.companyId, userId);
  if (role !== undefined) {
    if (!roleHasCapability(role, CAPABILITIES.PARTICIPATE)) {
      return deny(input, 'no_capability', { companyId: caseRow.companyId, side: 'client' });
    }
    return { ok: true, side: 'client', caseRow, mayRing: true };
  }

  const isHost = await hasEngagementCapability(
    { id: userId },
    ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
    {
      contextType: 'case',
      contextId: engagementId,
    }
  );
  if (isHost) {
    const delivering = await expertsRepository.findUserIdByProfileId(caseRow.expertProfileId);
    const mayRing = delivering?.user.id === userId;
    if (!mayRing) {
      log.info(
        { engagementId, userId, reason: 'not_delivering_expert' },
        'Call now: expert-side holder is not the delivering expert — may view, may not ring'
      );
    }
    return { ok: true, side: 'expert', caseRow, mayRing };
  }

  return deny(input, 'not_a_party', { companyId: caseRow.companyId });
}
