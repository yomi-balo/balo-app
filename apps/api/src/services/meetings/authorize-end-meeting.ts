/**
 * BAL-134 / ADR-1049 (D6 + D7) — THE **ONE** PLACE THE TWO END-AUTHORITY AXES ARE COMPOSED.
 *
 * ⚠⚠ AND THE ONE PLACE THAT MAY LOOK LIKE IT CONTRADICTS
 * `authorize-meeting-participation.ts`'s DOCBLOCK. IT DOES NOT — IT LANDS ON THE OTHER SIDE OF
 * THE VERY DISTINCTION THAT DOCBLOCK DRAWS, AND THIS PARAGRAPH IS WHY. That file says:
 *
 *   > "⚠ NEVER `CONSUME_CREDITS` — that is the wallet-drawdown token, and inviting a guest
 *   > spends nothing (the AC is "billing unaffected… never per-seat"). Gating a non-money
 *   > action on a money token is a category error."
 *
 * That rule is scoped to **INVITING A GUEST**, and its stated reasoning is that inviting SPENDS
 * NOTHING. **ENDING A LIVE CONSULTATION IS THE EXACT OPPOSITE**: it is the act that *stops* the
 * spend, on a per-minute meter, and it is the only client-side act in this feature that touches
 * money at all. "The party whose money is being spent may stop the spend" is the same category
 * the docblock is protecting, read from the other end. Do not "fix" this to `PARTICIPATE`.
 *
 * ── WHY `CONSUME_CREDITS` AND NOT ONE OF THE OTHER FIVE TOKENS (D6) ──────────────────────
 *
 * ADR-1049 excludes `PARTICIPATE` and names no replacement. Of the six shipped membership
 * tokens: `MANAGE_BILLING` is owner/admin-only and would stop a member — or a delegate acting
 * for the booker — ending their OWN consultation, contradicting the ADR's explicit "includes a
 * delegate acting for the booker"; `MANAGE_MEMBERS`, `MANAGE_REQUESTS` and
 * `APPROVE_OWN_PROPOSALS` are unrelated. That leaves `CONSUME_CREDITS`: base member bundle,
 * COMPANY-SCOPED BY CONSTRUCTION, semantically exact.
 *
 * ⚠ THREE THINGS SAID HONESTLY, OR THE CHOICE IS MISLEADING:
 *
 *   1. **Over the SHIPPED role map, `CONSUME_CREDITS` and `PARTICIPATE` are equivalent for a
 *      company member** — both sit in `MEMBER_BUNDLE`. The narrowing versus a guest or a
 *      link-share observer is STRUCTURAL, not token-driven: a guest has no `company_members`
 *      row, so `getMemberRole` answers `undefined` and every membership token fails closed.
 *      Choosing `CONSUME_CREDITS` honours the ADR's exclusion and future-proofs the split; it
 *      does not, today, exclude anyone `PARTICIPATE` would have admitted.
 *   2. **It DOES narrow one real case.** An agency `expert` shares `MEMBER_BUNDLE`, but this
 *      token is only ever resolved with a **company** scope — so an agency-side actor can never
 *      satisfy the client arm. The expert side comes through the engagement axis or not at all.
 *   3. **No `END_MEETINGS` token was invented.**
 *      `apps/web/src/invariants/engagement-capability-not-membership.test.ts` pins the
 *      membership union as a six-item literal, and the map is ADR-1029's to change, not this
 *      ticket's. ⚠ **FLAGGED FOR AN ADR-1049 AMENDMENT** so the next reader does not
 *      re-litigate it.
 *
 * ── THE EXPERT ARM (D7) ──────────────────────────────────────────────────────────────────
 *
 * `hasEngagementCapability(actor, HOST_MEETINGS, subject)` — the delivering expert plus their
 * agency `owner`/`admin`. Identical to the verdict `JoinGrant.isOwner` carries, computed by the
 * same call. ⚠ THE TWO FIELDS ARE NOT REDUNDANT: they diverge the moment the client arm is
 * true, and `isOwner` alone feeds the Daily token's `is_owner`. See `join-grant.ts`.
 *
 * ── ⚠ THIS MODULE DOES NOT DISCHARGE TENANCY ────────────────────────────────────────────
 *
 * `meeting_contexts.context_id` has NO FK and NO RLS, so resolving the owning party is the
 * caller's obligation — and `resolveHostContext` is an identity oracle that must never be
 * reached on an unvetted `meetingId`. Every caller runs `authorizeMeetingParticipation` FIRST
 * and passes what it resolved (that is why this function takes a `subject` and a `companyId`
 * rather than a bare `meetingId`).
 */
import { partyMembershipsRepository } from '@balo/db';
import { CAPABILITIES, ENGAGEMENT_CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { canEndMeeting, endedByForActor, type MeetingEndedBy } from '@balo/shared/meetings';
import {
  hasEngagementCapability,
  type EngagementHostSubject,
} from './authorize-engagement-host.js';

const log = createLogger('meeting-end-authz');

export interface ResolveEndAuthorityInput {
  readonly userId: string;
  /** The company that owns the meeting's primary context — from the participation gate. */
  readonly companyId: string;
  /** The already-resolved primary context — from the participation gate. */
  readonly subject: EngagementHostSubject;
}

export interface EndAuthority {
  readonly canEndMeeting: boolean;
  /**
   * The label to stamp on `meetings.ended_by`, or `null` when the actor may not end.
   * ⚠ NEVER `system_idle` — that belongs to the sweep.
   */
  readonly endedBy: MeetingEndedBy | null;
  /** ⚠ A LOG FIELD ONLY. The wire gets one literal; see the end service. */
  readonly isExpertHost: boolean;
  /** ⚠ A LOG FIELD ONLY. */
  readonly isClientPrincipal: boolean;
}

/**
 * Resolve both axes and combine them through the ONE shared rule.
 *
 * ⚠ THE TWO READS RUN CONCURRENTLY. They are independent — one is a membership row, the other
 * a host-context resolution — and this is on the path of a button that must always work.
 *
 * ⚠ ROLE INTERPRETATION GOES THROUGH `@balo/shared/authz`, NEVER a `role === 'owner'` here.
 * ADR-1029 HARD CONSTRAINT B: `roleHasCapability` is the single place a role string becomes a
 * capability.
 */
export async function resolveEndAuthority(input: ResolveEndAuthorityInput): Promise<EndAuthority> {
  const { userId, companyId, subject } = input;

  const [companyRole, isExpertHost] = await Promise.all([
    partyMembershipsRepository.getMemberRole('company', companyId, userId),
    hasEngagementCapability({ id: userId }, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, subject),
  ]);

  // ⚠ `undefined` = NO LIVE MEMBERSHIP = a guest, a delegate with no user row, an agency-side
  // actor, or a Balo staffer. Every membership token fails closed on it, structurally.
  const isClientPrincipal =
    companyRole !== undefined && roleHasCapability(companyRole, CAPABILITIES.CONSUME_CREDITS);

  const authority = { isExpertHost, isClientPrincipal };
  return {
    canEndMeeting: canEndMeeting(authority),
    endedBy: endedByForActor(authority),
    isExpertHost,
    isClientPrincipal,
  };
}

/**
 * Log a denial with the SHAPE attached — the wire gets one literal and nothing else.
 *
 * ⚠ EXPORTED SO THE ONE `log.warn` LIVES BESIDE THE RULE IT EXPLAINS rather than being
 * reconstructed at each call site (there are two: the end route and the state route's future
 * siblings). Never called on a grant.
 */
export function logEndAuthorityDenied(
  meetingId: string,
  userId: string,
  authority: EndAuthority,
  side: string
): void {
  log.warn(
    {
      meetingId,
      userId,
      side,
      isExpertHost: authority.isExpertHost,
      isClientPrincipal: authority.isClientPrincipal,
      reason: 'no_end_authority',
    },
    'Meeting end denied'
  );
}
