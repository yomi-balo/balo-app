/**
 * BAL-466 (D3) — WHO MAY ACT ON THIS MEETING, as a PURE RULE WITH INJECTED READS.
 *
 * ⚠ THIS MODULE EXISTS TO KILL A SECOND DEFINITION — the same reason `context-owner.ts`
 * exists, one level up. `apps/api`'s `authorizeMeetingParticipation` was the only
 * implementation of the two-sided tenancy gate, and `apps/web`'s in-call money surface needs
 * the identical verdict. Copying it would have produced two answers to one question, which is
 * exactly what CLAUDE.md's `relationshipDeniesHosting` discipline forbids. The RULE now lives
 * here, ONCE, and both apps are fetch-and-call wrappers over it.
 *
 * ── THE TWO AXES (unchanged from `apps/api`'s original — this is a MOVE, not a redesign) ────
 *
 *   · CLIENT SIDE → the MEMBERSHIP axis, COMPANY scope, `PARTICIPATE`. ⚠ NEVER
 *     `CONSUME_CREDITS`: that is the wallet-drawdown token, and participating spends nothing.
 *     Role interpretation goes through `roleHasCapability` (ADR-1029 HARD CONSTRAINT B) and
 *     never a `role ===` comparison.
 *   · EXPERT SIDE → the ENGAGEMENT axis (ADR-1046), `manage_engagement`, reached ONLY when the
 *     actor holds no company membership at all, so the two arms cannot both fire and the side
 *     is unambiguous. ⚠ NOT `actorHasExpertSideVisibility`'s wider "any live agency member"
 *     set — that is the VISIBILITY rule (ADR-1046 §7) and this is an ACT gate.
 *   · NEITHER → denied.
 *
 * ── THE ORDER OF THE CHECKS IS PART OF THE CONTRACT ─────────────────────────────────────────
 *
 * meeting → primary context → owning party → **AUTHORIZATION BEFORE ANY COHERENCE OR STATE
 * CHECK** → one denial shape. Running a state check first would let an actor with membership
 * nowhere distinguish states of a guessed `meetingId` — an existence oracle over every meeting
 * on the platform. Meeting state (`meetings.status`) and engagement lifecycle
 * (`engagements.status`) are the CALLER's, deliberately: this rule reports, callers check.
 *
 * ── WHY INJECTED READS ──────────────────────────────────────────────────────────────────────
 *
 * `packages/shared` is pure and cannot depend on `@balo/db` (`@balo/db` depends on IT, and a
 * value import would drag `postgres` into every consumer's bundle). More importantly the
 * injection is the BEHAVIOUR-PRESERVATION PROOF for the `apps/api` refactor: that gate's test
 * mocks `@balo/db` with a FACTORY LITERAL naming exactly six repositories, and a vitest factory
 * mock throws on any export it omits. Because the wrapper passes the very repository functions
 * it already imports — and calls them with the same arguments, in the same order —
 * `authorize-meeting-participation.test.ts` stays green COMPLETELY UNCHANGED. That is the
 * proof, not a convenience.
 *
 * ⚠ THIS MODULE DOES NOT LOG. The DENIAL SHAPE is returned so each app logs it in its own
 * voice with its own fields — the same split `context-owner.ts` makes ("logging is a service
 * concern, and a pure rule with a logger in it stops being pure"). It also never throws: both
 * callers are authorization gates, and a gate must never have to catch to stay safe.
 */
import { CAPABILITIES, roleHasCapability } from '../authz';
import {
  selectPrimaryMeetingContext,
  type MeetingContextRowLike,
  type MeetingGuestSide,
  type PrimaryMeetingContext,
} from './guest-participation';
import type { MeetingContextOwner } from './context-owner';

/** Which side of the meeting the actor was resolved onto. NEVER taken from request input. */
export type MeetingParticipationSide = MeetingGuestSide;

/**
 * Which read came back empty, or which axis refused. ⚠ A LOG FIELD, NEVER A WIRE VALUE — every
 * member of this union collapses into ONE literal at both wrappers.
 */
export type MeetingParticipationDenialReason =
  | 'no_meeting'
  | 'no_context'
  | 'ambiguous_context'
  | 'subject_unresolvable'
  | 'cross_tenant'
  | 'no_capability';

/**
 * The four reads the rule needs, injected by the caller.
 *
 * ⚠ EACH MUST ALREADY FILTER SOFT-DELETED ROWS. `undefined` means "no live row", and this
 * module cannot tell the difference — which is what lets missing and soft-deleted share one
 * denial without extra work.
 */
export interface MeetingParticipationReads<TMeeting> {
  readonly findMeeting: (meetingId: string) => Promise<TMeeting | undefined>;
  readonly listMeetingContexts: (meetingId: string) => Promise<readonly MeetingContextRowLike[]>;
  /**
   * The owning party of the primary context, from the context's OWN row.
   *
   * ⚠ THE CALLER OWNS THE EXHAUSTIVENESS WITNESS AND THE INTEGRITY LOG. `apps/api` passes its
   * `loadOwningParty` (which keeps the `never` witness beside its `log.warn`); `apps/web`
   * passes `@balo/db`'s ready-bound `resolveMeetingContextOwner`. Both already answer
   * `MeetingContextOwner | undefined`, so neither had to change shape.
   */
  readonly resolveOwner: (
    subject: PrimaryMeetingContext
  ) => Promise<MeetingContextOwner | undefined>;
  /** The actor's LIVE company role, or `undefined`. ⚠ COMPANY scope — never agency. */
  readonly findCompanyMemberRole: (
    companyId: string,
    userId: string
  ) => Promise<string | undefined>;
  /**
   * The ENGAGEMENT axis, bound by the app. ⚠ IT MUST ASK FOR `manage_engagement`, and it must
   * be TOTAL over the six holder-bearing context labels — an app that has not implemented an
   * arm MUST fail closed and say so in its own docblock (see `apps/web`'s binding).
   */
  readonly holdsEngagementCapability: (
    userId: string,
    subject: PrimaryMeetingContext
  ) => Promise<boolean>;
}

export interface ResolveMeetingParticipationInput {
  readonly meetingId: string;
  readonly userId: string;
}

/**
 * BAL-466 (F16, review fix round) — THE AUTHORIZED-BRANCH FIELDS, EXPORTED SO NEITHER WRAPPER
 * HAND-DECLARES THIS SHAPE A SECOND TIME. Before this, `apps/api`'s
 * `AuthorizeMeetingParticipationResult`'s `ok: true` arm and `apps/web`'s identically-shaped
 * twin (`lib/authz/meeting-participation.ts`) each restated these five fields byte-identically
 * — exactly the "defined once, imported everywhere" duplication CLAUDE.md's data-driven rule
 * warns against. Both wrappers now compose `{ ok: true } & MeetingParticipationOk<Meeting>`
 * instead. Deliberately NOT unifying the `ok: false` denial arm here — the two apps' error-code
 * literals are free to diverge (they already do: `apps/api` names its own
 * `AuthorizeMeetingParticipationErrorCode`).
 */
export interface MeetingParticipationOk<TMeeting> {
  /** ⚠ The side the caller must use. NEVER read off a request body. */
  readonly side: MeetingParticipationSide;
  readonly meeting: TMeeting;
  readonly subject: PrimaryMeetingContext;
  readonly companyId: string;
  /** `null` for a `match`-routed `project_discovery`, which names nobody. */
  readonly expertProfileId: string | null;
}

export type ResolveMeetingParticipationResult<TMeeting> =
  | ({ readonly outcome: 'authorized' } & MeetingParticipationOk<TMeeting>)
  | {
      readonly outcome: 'denied';
      readonly reason: MeetingParticipationDenialReason;
      /** Contextual ids for the caller's `log.warn`. ⚠ IDS ONLY — never a token or a name. */
      readonly fields: Readonly<Record<string, string | number | null>>;
    };

export async function resolveMeetingParticipation<TMeeting>(
  input: ResolveMeetingParticipationInput,
  reads: MeetingParticipationReads<TMeeting>
): Promise<ResolveMeetingParticipationResult<TMeeting>> {
  const { meetingId, userId } = input;

  // 1. The meeting. Missing and soft-deleted are ONE outcome.
  const meeting = await reads.findMeeting(meetingId);
  if (meeting === undefined) {
    return { outcome: 'denied', reason: 'no_meeting', fields: { userId, meetingId } };
  }

  // 2. The PRIMARY context (the precedence rule).
  const contexts = await reads.listMeetingContexts(meetingId);
  const primary = selectPrimaryMeetingContext(contexts);
  if (!primary.ok) {
    return {
      outcome: 'denied',
      reason: primary.reason === 'ambiguous' ? 'ambiguous_context' : 'no_context',
      fields: { userId, meetingId, contextCount: contexts.length },
    };
  }
  const subject = primary.context;

  // 3. The owning party, from the primary context's OWN row.
  const owner = await reads.resolveOwner(subject);
  if (owner === undefined) {
    return {
      outcome: 'denied',
      reason: 'subject_unresolvable',
      fields: { userId, meetingId, contextType: subject.contextType, contextId: subject.contextId },
    };
  }
  const { companyId, expertProfileId } = owner;

  // ── 4. AUTHORIZATION. Nothing below this point runs before a side is proven. ──
  const role = await reads.findCompanyMemberRole(companyId, userId);
  if (role !== undefined) {
    if (!roleHasCapability(role, CAPABILITIES.PARTICIPATE)) {
      return {
        outcome: 'denied',
        reason: 'no_capability',
        fields: { userId, meetingId, companyId, side: 'client' },
      };
    }
    return { outcome: 'authorized', side: 'client', meeting, subject, companyId, expertProfileId };
  }

  // ⚠ SAFE HERE SPECIFICALLY BECAUSE STEP 3 ALREADY RESOLVED THIS CONTEXT'S OWNING PARTY FROM
  // ITS OWN ROW — the tenancy obligation `resolveHostContext`'s header assigns to its callers.
  // It is NOT safe on an unvetted `contextId`; that seam is an identity oracle.
  if (await reads.holdsEngagementCapability(userId, subject)) {
    return { outcome: 'authorized', side: 'expert', meeting, subject, companyId, expertProfileId };
  }

  return {
    outcome: 'denied',
    reason: 'cross_tenant',
    fields: { userId, meetingId, companyId, contextType: subject.contextType },
  };
}
