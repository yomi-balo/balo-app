/**
 * BAL-410 — the `booking.cancelled` LABEL RESOLUTION + PUBLISH ENVELOPE. The `apps/api`-side
 * sibling of `apps/web`'s `publish-booking-rescheduled.ts`.
 *
 * ⚠⚠ WHY THIS PUBLISHES FROM `apps/api` WHEN ITS SIBLINGS PUBLISH FROM `apps/web`. The ADMIN
 * override arm is an explicit AC and has NO WEB SURFACE, so a web publisher would notify NOBODY
 * on an admin cancel. Three secondary benefits fall out of the same choice: the event goes in
 * `ServerOnlyNotificationEvent`, so `routes/notifications/schema.ts` needs no arm (adding one
 * would be a `StraySchemaArm` and fail `tsc`); `apps/web/src/lib/notifications/types.ts` needs
 * no hand-kept mirror; and the audit id is in the SAME PROCESS, so there is no deploy-skew
 * `auditId ?? window` fallback to get wrong.
 *
 * ⚠ IT IS CALLED FROM THE ROUTE, NEVER FROM `cancelMeeting`. The dev seeder is a live caller of
 * `cancelMeeting`; publishing from the service would fire real cancellation emails on every
 * `pnpm db:seed`. The route is unreachable from the seeder.
 *
 * ── HOW BOTH SIDES GET TOLD, WITHOUT A NEW RECIPIENT KIND ─────────────────────────────────
 *
 * The ticket requires "Cancelled by expert → client → email + in-app". `recipient: 'client'`
 * resolves a SINGLE `payload.recipientId`, and on the expert/admin arms there is no single
 * client user id in hand — so that arm alone would leave the client uninformed. The answer is
 * the ALREADY-SHIPPED fan-out kind `'meeting_party_participants'` (BAL-408,
 * `engine/dispatcher.ts`), whose contract is that the **PUBLISHER** resolves
 * `payload.recipientUserIds` and the engine merely fans out over them — deliberately, so no
 * membership read ever lands inside the notification engine. This module holds the meeting, its
 * resolved context and the owning company, so it can make that read itself:
 *
 *   · CLIENT-initiated  ⇒ `recipientId` = the acting user (their own confirmation);
 *                         `recipientUserIds` OMITTED, so the fan-out rule delivers nothing and
 *                         nobody is told twice. The EXPERT side is reached by the shipped
 *                         single-recipient `recipient: 'expert'` rule.
 *   · EXPERT/ADMIN-initiated ⇒ `recipientId` OMITTED (the client rule skips);
 *                         `recipientUserIds` = the CLIENT company's live `MANAGE_MEMBERS`
 *                         holders. The expert still gets their own confirmation from the
 *                         unconditioned expert rule.
 *
 * ⚠ THE NARROWING IS STATED RATHER THAN HIDDEN, and it is the same one `meeting-absence.ts`
 * records for its client nudge: `partyMembershipsRepository` exposes no `listMemberUserIds`, so
 * the widest set reachable without adding an un-integration-tested repository method is the
 * `MANAGE_MEMBERS` holders. Consequence, plainly: a plain `member` who booked the consultation
 * is not emailed directly, only their owner/admin. A follow-up ticket should add a live-member
 * listing (with its integration test) and widen this one call — the same follow-up
 * `meeting-absence.ts` already asks for. The role set is derived from `@balo/shared/authz`'s map
 * INSIDE the repository, never from a `role ===` here.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3). No address is ever assembled here: the
 * engine resolves recipients from IDs and the email adapter fetches the address from the `users`
 * row at delivery time. `BookingCancelledPayload` has no address-shaped field to leak, and the
 * `recipient: 'email_address'` kind (the one sanctioned address-carrying shape, for NON-users)
 * is deliberately not used — the guest arm of a cancellation is BAL-476's, together with the
 * `METHOD:CANCEL` it must accompany.
 *
 * ⚠ FAIL-SOFT THROUGHOUT. A cancellation has ALREADY COMMITTED by the time this runs; a label
 * read that fails degrades to neutral fallbacks and still publishes, and the caller wraps the
 * whole thing so a publish failure can never 500 a committed cancel.
 */
import {
  agenciesRepository,
  caseEngagementsRepository,
  companiesRepository,
  expertsRepository,
  partyMembershipsRepository,
  usersRepository,
} from '@balo/db';
import {
  expertPartyDisplayName,
  personDisplayName,
  personWithOrgLabel,
} from '@balo/shared/parties';
import type { PrimaryMeetingContext } from '@balo/shared/meetings';
import type { BookingCancelledPayload } from '@balo/shared/notifications';
import type { FastifyBaseLogger } from 'fastify';
import { notificationEvents } from '../../notifications/index.js';
import type { CancelActorRole } from './authorize-meeting-cancel.js';

/** Neutral, party-shaped fallbacks. Never a placeholder that reads as an unsubstituted token. */
const FALLBACK_CLIENT_COMPANY = 'your company';
const FALLBACK_EXPERT_PARTY = 'Your expert';
const FALLBACK_CASE_TITLE = 'your case';
/** ⚠ A Balo staff member is NEVER named to the parties. */
const ADMIN_ACTOR_LABEL = 'Balo support';

export interface PublishBookingCancelledInput {
  meetingId: string;
  /** From `authorizeMeetingCancel` — the case gate, resolved once and threaded, never re-read. */
  subject: PrimaryMeetingContext;
  companyId: string | null;
  expertProfileId: string | null;
  actorUserId: string;
  /** WHICH ARM authorized it. Server-derived; drives both the copy and the recipient shape. */
  cancelledBy: CancelActorRole;
  scheduledStart: Date;
  scheduledEnd: Date;
  /** The `meeting.cancelled` audit row id — the per-WRITE correlation key. */
  cancelAuditId: string;
  holdReleased: boolean;
  /**
   * A SERVICE parameter, never a wire field. `'expert_time_off'` is BAL-416's cancel branch,
   * whose affordance is deliberately not in this PR; no shipped caller passes anything but the
   * default.
   */
  reason?: 'requested' | 'expert_time_off';
}

interface ResolvedLabels {
  clientCompanyName: string;
  expertPartyLabel: string;
  /** The acting PERSON's bare name — combined with a party label by `buildActorLabel`. */
  actorPersonName: string | null;
  caseTitle: string;
}

/**
 * Every display label the payload needs, from column-projected reads. NEVER THROWS — the caller
 * relies on that, because the cancellation has already committed.
 */
async function resolveLabels(
  companyId: string,
  expertProfileId: string,
  engagementId: string,
  actorUserId: string
): Promise<ResolvedLabels> {
  const [company, profile, caseRow, actorUser] = await Promise.all([
    companiesRepository.findNameById(companyId),
    expertsRepository.findDisplayProfileById(expertProfileId),
    caseEngagementsRepository.findByEngagementId(engagementId),
    usersRepository.findDisplayById(actorUserId),
  ]);

  // ⚠ THE EXPERT PARTY LABEL IS BUILT FROM THE **EXPERT'S** USER ROW, NEVER THE ACTOR'S — the
  // two are the same person only on an expert-initiated cancel, and using the actor would name
  // the CLIENT as the expert party on every client-initiated one. Second wave, because both
  // reads depend on `profile`.
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);

  const actorName = personDisplayName(
    actorUser?.firstName ?? null,
    actorUser?.lastName ?? null,
    ''
  );

  return {
    clientCompanyName: company?.name ?? FALLBACK_CLIENT_COMPANY,
    expertPartyLabel:
      profile === undefined
        ? FALLBACK_EXPERT_PARTY
        : expertPartyDisplayName({
            type: profile.type,
            agencyName: agency?.name ?? null,
            firstName: expertUser?.firstName ?? null,
            lastName: expertUser?.lastName ?? null,
          }),
    actorPersonName: actorName.length > 0 ? actorName : null,
    caseTitle: caseRow?.title ?? FALLBACK_CASE_TITLE,
  };
}

/**
 * RETROSPECTIVE attribution — CLAUDE.md's by-tense rule: name the PERSON, with "@ company/agency"
 * on first mention. `personWithOrgLabel` drops the "@ org" clause when the org is blank or is
 * itself the person's name (an independent expert keeps their own name).
 *
 * ⚠ The admin arm is a LITERAL, never a name: a Balo staff member is never identified to the
 * parties. Degrades to the acting side's PARTY label when the person read produced nothing.
 */
function buildActorLabel(
  cancelledBy: CancelActorRole,
  labels: Pick<ResolvedLabels, 'actorPersonName' | 'clientCompanyName' | 'expertPartyLabel'>
): string {
  if (cancelledBy === 'admin') {
    return ADMIN_ACTOR_LABEL;
  }
  const partyLabel = cancelledBy === 'client' ? labels.clientCompanyName : labels.expertPartyLabel;
  if (labels.actorPersonName === null) {
    return partyLabel;
  }
  return personWithOrgLabel(labels.actorPersonName, partyLabel);
}

/**
 * The CLIENT-side recipients for an expert- or admin-initiated cancel. Empty on the client arm
 * (the actor is already named by `recipientId`, and telling them twice is noise).
 */
async function resolveCounterpartyRecipients(
  cancelledBy: CancelActorRole,
  companyId: string
): Promise<string[]> {
  if (cancelledBy === 'client') {
    return [];
  }
  return partyMembershipsRepository.listAdminUserIds('company', companyId);
}

/**
 * Publish `booking.cancelled` for a COMMITTED cancellation.
 *
 * ⚠ GATED TO `contextType: 'case'` (v1). A `project_kickoff`, `package_session`,
 * `retainer_checkin`, `project_discovery` or `request_interaction` cancel is a real
 * cancellation and still writes its audit row and releases its hold — it simply has no
 * case-shaped notification templates to render, and inventing generic copy for five context
 * kinds is its own ticket. The skip is LOGGED at `info`, never silent.
 */
export async function publishBookingCancelled(
  input: PublishBookingCancelledInput,
  log: FastifyBaseLogger
): Promise<void> {
  const { meetingId, subject, companyId, expertProfileId, actorUserId, cancelledBy } = input;

  if (subject.contextType !== 'case' || companyId === null || expertProfileId === null) {
    log.info(
      { meetingId, contextType: subject.contextType, hasCompany: companyId !== null },
      'booking.cancelled not published — v1 notifies for case consultations only'
    );
    return;
  }
  const engagementId = subject.contextId;

  const labels = await resolveLabels(companyId, expertProfileId, engagementId, actorUserId).catch(
    (error: unknown) => {
      log.error(
        {
          meetingId,
          engagementId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve booking.cancelled labels — publishing with neutral fallbacks'
      );
      return {
        clientCompanyName: FALLBACK_CLIENT_COMPANY,
        expertPartyLabel: FALLBACK_EXPERT_PARTY,
        actorPersonName: null,
        caseTitle: FALLBACK_CASE_TITLE,
      } satisfies ResolvedLabels;
    }
  );

  const recipientUserIds = await resolveCounterpartyRecipients(cancelledBy, companyId).catch(
    (error: unknown) => {
      log.error(
        {
          meetingId,
          engagementId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve booking.cancelled counterparty recipients — the expert is still notified'
      );
      return [] as string[];
    }
  );

  if (cancelledBy !== 'client' && recipientUserIds.length === 0) {
    // ⚠ NOT a silent send. Both client-side channels fan out from this list, so an empty one
    // delivers nothing — recording that as a normal publish would be the one shape a promise
    // must never take. The publish still happens (the expert half is real); this line is what
    // makes "the client was not reached" legible in the log.
    log.warn(
      { meetingId, engagementId, companyId, cancelledBy },
      'No live MANAGE_MEMBERS holder on the client company — the client side of this cancellation reaches nobody'
    );
  }

  const durationMinutes = Math.round(
    (input.scheduledEnd.getTime() - input.scheduledStart.getTime()) / 60_000
  );

  const payload: BookingCancelledPayload = {
    // ⚠ PER WRITE, NEVER PER STATE — a bare `meetingId` collides against BullMQ's retained
    // completed set, and a cancel has no destination window to key on.
    correlationId: `${meetingId}:${input.cancelAuditId}`,
    meetingId,
    engagementId,
    ...(cancelledBy === 'client' ? { recipientId: actorUserId } : {}),
    ...(recipientUserIds.length > 0 ? { recipientUserIds } : {}),
    expertProfileId,
    clientCompanyName: labels.clientCompanyName,
    expertPartyLabel: labels.expertPartyLabel,
    caseTitle: labels.caseTitle,
    scheduledStartIso: input.scheduledStart.toISOString(),
    durationMinutes,
    cancelledBy,
    cancelledByLabel: buildActorLabel(cancelledBy, labels),
    holdReleased: input.holdReleased,
    reason: input.reason ?? 'requested',
  };

  await notificationEvents.publish('booking.cancelled', payload);
}
