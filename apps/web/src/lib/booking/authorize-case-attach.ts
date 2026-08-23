import 'server-only';

import { caseEngagementsRepository } from '@balo/db';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';

/**
 * BAL-400 (Decision 6) — the ONE write gate for "attach this booking to an existing case",
 * reached from THREE places: the chooser's "attach to an existing case" arm (entry points 1/2),
 * and the case-surface quick-pick's FIXED case (entry point 3, `fixedEngagementId`).
 *
 * ⚠⚠ THE WRAPPER IS A CLIENT COMPONENT, SO `engagementId` IS CLIENT-SUPPLIED AND MUST BE
 * TREATED AS FORGED UNTIL PROVEN OTHERWISE. The read gate on `/cases/[engagementId]`
 * (`resolveCaseAccess` → `authorizeEngagementConversation`) governs whether THAT PAGE renders —
 * it does NOT authorize this write, which arrives as a separate request with its own trust
 * boundary. Every caller of this function must call it, even the case-surface quick-pick, whose
 * `engagementId` looks "already known" but was never re-verified server-side until now.
 *
 * ORDER IS THE POINT (mirrors `authorize-meeting-booking.ts`'s ADR-1045 §2 ordering rule):
 * AUTHORIZE FIRST, on the membership axis, over the row's OWN company — before any coherence or
 * state check. Reaching a coherence check therefore already proves the actor is a live
 * CONSUME_CREDITS member of the case's company, so branching on `engagementType` / `status` /
 * `closedAt` / `expertProfileId` AFTER that point leaks nothing to an outside caller — the same
 * collapse `authorize-meeting-booking.ts` and `openSession`'s `meeting_not_bookable` make, and
 * for the same reason (no existence/type oracle over `engagements.id`).
 *
 * ⚠ EVERY DENIAL RETURNS THE SAME LITERAL, `case_not_available`. The DISTINCT reason goes to the
 * log only (`log.warn`) — never to the wire, and never rendered. A forged `engagementId` for a
 * company the actor is not a billing member of is indistinguishable, on the wire, from an
 * `engagementId` that resolves to nothing at all.
 *
 * Defence in depth downstream: `POST /meetings` independently runs `authorizeMeetingBooking` on
 * the submitted `contextId` (`PARTICIPATE` on the owning company), so even a bug here cannot book
 * across tenants.
 */

export type CaseAttachResult =
  | {
      readonly ok: true;
      readonly engagementId: string;
      readonly companyId: string;
      /**
       * ⚠ THE ROW'S OWN `expert_profile_id`, echoed back so the caller can stop reading the
       * CLIENT'S claimed one (S1/M5). It is byte-equal to the submitted `expertProfileId` —
       * the `expert_mismatch` denial below is what makes that true — and returning it means a
       * caller never has to hold the client's value at all.
       */
      readonly expertProfileId: string;
      readonly title: string;
    }
  | { readonly ok: false; readonly code: 'case_not_available' };

type DenyReason =
  | 'no_engagement'
  | 'no_capability'
  | 'not_a_case'
  | 'engagement_not_active'
  | 'case_closed'
  | 'expert_mismatch';

function deny(
  reason: DenyReason,
  input: { actorUserId: string; engagementId: string; expertProfileId: string }
): { readonly ok: false; readonly code: 'case_not_available' } {
  log.warn('Case attach denied', {
    reason,
    actorUserId: input.actorUserId,
    engagementId: input.engagementId,
    expertProfileId: input.expertProfileId,
  });
  return { ok: false, code: 'case_not_available' };
}

export async function authorizeCaseAttach(input: {
  /** The signed-in, onboarded actor attempting the attach. */
  actorUserId: string;
  /** The (possibly forged) case to attach to. */
  engagementId: string;
  /** The expert the booking wrapper is booking — pins the (case, expert) PAIR. */
  expertProfileId: string;
}): Promise<CaseAttachResult> {
  // 1. LOAD. Loading is not authorizing — live rows only.
  const row = await caseEngagementsRepository.findByEngagementId(input.engagementId);
  if (row === undefined) {
    return deny('no_engagement', input);
  }

  // 2. AUTHORIZE FIRST — membership axis, company scope, on the CASE's OWN company.
  const allowed = await hasCapability({ id: input.actorUserId }, CAPABILITIES.CONSUME_CREDITS, {
    companyId: row.companyId,
  });
  if (!allowed) {
    return deny('no_capability', input);
  }

  // 3. ONLY THEN coherence/state. Reaching here already proves membership, so these branches
  //    leak nothing to an actor who could not have reached them anyway.
  if (row.engagementType !== 'case') {
    return deny('not_a_case', input);
  }
  if (row.status !== 'active') {
    return deny('engagement_not_active', input);
  }
  if (row.closedAt !== null) {
    return deny('case_closed', input);
  }
  if (row.expertProfileId !== input.expertProfileId) {
    return deny('expert_mismatch', input);
  }

  return {
    ok: true,
    engagementId: row.id,
    companyId: row.companyId,
    expertProfileId: row.expertProfileId,
    title: row.title,
  };
}
