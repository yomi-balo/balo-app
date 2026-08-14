/**
 * BAL-408 / ADR-1044 — the guest lifecycle service: invite, remove, admit, deny.
 *
 * ⚠⚠ TWO FIELDS ARE SERVER-DERIVED AND MUST NEVER BECOME REQUEST FIELDS:
 *   · `party`       — from the gate's resolved SIDE (`authorizeMeetingParticipation`).
 *                     This is the anti-cross-party control; see that module's docblock.
 *   · `accessScope` — computed HERE, at invite time, and STORED. See `resolveGuestAccessScope`.
 * The Zod schema in `routes/meetings/guests.schema.ts` deliberately has no key for either.
 *
 * ⚠ MINT BEFORE PUBLISH, AND THE ORDER IS ASSERTED BY A TEST. The raw join token exists only
 * in memory; if the publish were attempted first it would carry no credential, and if the
 * row write failed after publishing we would have emailed a link to a guest that does not
 * exist. Write first, publish after — the `review-nudge-sweep.test.ts` `invocationCallOrder`
 * precedent pins it.
 *
 * ⚠ NOTIFICATION AND ANALYTICS FAILURES MUST NOT UNDO A COMMITTED INVITE. The rows are
 * already durable when we publish; a queue hiccup is an undelivered email, not a failed
 * invite. Both are therefore best-effort per guest and logged at the boundary — the
 * alternative (throwing) would 500 a request whose database work fully succeeded and invite
 * the caller to retry into a `guest_already_invited`.
 */
import {
  agenciesRepository,
  caseEngagementsRepository,
  companiesRepository,
  expertsRepository,
  meetingGuestsRepository,
  partyDomainsRepository,
  partyMembershipsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  usersRepository,
  type MeetingGuest,
  type MeetingGuestPublic,
  type MeetingStatus,
} from '@balo/db';
import {
  GUEST_SERVER_EVENTS,
  trackServer,
  type GuestInviteEntryPoint,
} from '@balo/analytics/server';
import { classifyEmailDomain, extractEmailDomain } from '@balo/shared/domains';
import { createLogger } from '@balo/shared/logging';
import {
  GUEST_TOKEN_TTL_AFTER_END_MS,
  MAX_MEETING_PARTICIPANTS,
  RESERVED_BASE_PARTICIPANTS,
  projectGuestForViewer,
  type GuestAccessScopeLabel,
  type GuestForViewer,
  type PrimaryMeetingContext,
  type MeetingGuestSide,
  type MeetingParticipationRoleLabel,
} from '@balo/shared/meetings';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { notificationEvents } from '../../notifications/index.js';
import { mintGuestInviteToken } from '../../lib/guest-token.js';
import { hasEngagementCapability } from './authorize-engagement-host.js';
import {
  authorizeMeetingParticipation,
  type AuthorizeMeetingParticipationResult,
} from './authorize-meeting-participation.js';

const log = createLogger('guest-participation');

/**
 * ⚠ GATE ON THE **TERMINAL** SET, NEVER AN ALLOW-LIST. `meeting_status` has FIVE labels, not
 * four — `scheduled | waiting_for_participants | in_progress | ended | cancelled`. An
 * `IN ('scheduled','in_progress')` allow-list would have silently excluded
 * `waiting_for_participants`, which is PRECISELY the lobby state in which admit/deny matters
 * most, and a sixth label added later would fall outside it too. Naming what is CLOSED means
 * a new label defaults to OPEN, which is the correct direction for a roster action.
 *
 * ⚠ TYPED AS `MeetingStatus`, NOT `string`. A bare `string` collection accepts any literal,
 * so a typo (`'endeed'`) or a renamed `meeting_status` pgEnum label would silently OPEN the
 * gate with no typecheck failure — the one direction a fail-closed check must never drift
 * in. The schema-derived type makes both a compile error.
 */
const MEETING_CLOSED_TO_GUESTS: ReadonlySet<MeetingStatus> = new Set(['ended', 'cancelled']);

/** Every wire literal this service can produce. All fixed; none derived from an error message. */
export type GuestServiceErrorCode =
  | 'meeting_not_found'
  | 'meeting_not_open_for_guests'
  | 'participant_cap_reached'
  | 'guest_already_invited'
  | 'delegate_must_be_client_side'
  | 'guest_not_found'
  | 'guest_not_pending'
  /**
   * BAL-436 — the row exists and the actor may host it, but it is not a re-sendable row: a
   * re-send only makes sense for a `link`-channel guest a host has already ADMITTED. An
   * `email` invitee has an inviter and a re-invite path; a `pending` knock has not been let
   * in yet, so there is nothing to re-send.
   */
  | 'guest_link_not_resendable';

export interface InviteGuestInput {
  email: string;
  name?: string;
  participationRole?: MeetingParticipationRoleLabel;
}

export interface InviteGuestsInput {
  meetingId: string;
  actorUserId: string;
  entryPoint: GuestInviteEntryPoint;
  guests: InviteGuestInput[];
}

export interface InvitedGuestSummary {
  id: string;
  email: string;
  name: string | null;
  party: MeetingGuestSide;
  participationRole: MeetingParticipationRoleLabel;
  accessScope: GuestAccessScopeLabel;
  admission: 'pre_admitted';
  invitedAt: string;
}

export interface GuestRosterCounts {
  participantCount: number;
  participantCap: number;
}

export type InviteGuestsResult =
  | ({ ok: true; guests: InvitedGuestSummary[] } & GuestRosterCounts)
  | { ok: false; code: GuestServiceErrorCode };

export type ListGuestsResult =
  | ({ ok: true; guests: GuestForViewer[]; canHost: boolean } & GuestRosterCounts)
  | { ok: false; code: GuestServiceErrorCode };

export type RemoveGuestResult = { ok: true } | { ok: false; code: GuestServiceErrorCode };

export type DecideAdmissionResult =
  | { ok: true; id: string; admission: 'admitted' | 'denied'; decidedAt: string }
  | { ok: false; code: GuestServiceErrorCode };

/**
 * BAL-436 — the re-send's answer.
 *
 * ⚠⚠ **THE RAW TOKEN IS NOT ON THIS SHAPE, AND MUST NEVER BE.** It goes into the notification
 * payload and nowhere else — the same rule `inviteGuests` keeps. A UI does not build join
 * links (`guests.ts` contract point 4); the engine emails them.
 */
export type ResendGuestLinkResult =
  | { ok: true; id: string; expiresAt: string }
  | { ok: false; code: GuestServiceErrorCode };

/** A Postgres unique violation — the concurrent-invite race, mapped rather than 500'd. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/**
 * ⚠ CANONICALISE BEFORE EVERYTHING. `@balo/db` never normalises input (the `party_domains` /
 * `proposal_share_links` convention), and `meeting_guest_meeting_email_live_idx` matches the
 * STORED BYTES — so a caller that skips this silently permits `Dana@x.com` alongside
 * `dana@x.com` as two live invites to one meeting. Lowercased + trimmed here, once, before
 * the domain read, before the unique index, and before the notification payload.
 *
 * ⚠ EXPORTED FOR BAL-132, NOT COPIED. `claimLobbyPlace` writes into the SAME partial unique
 * index (`meeting_guest_meeting_email_live_idx`), which is the only bound on one visitor
 * spamming N pending rows into a host's queue — and that index matches the STORED BYTES. A
 * second definition of "the same address" on the lobby path would let `Dana@x.com` and
 * `dana@x.com` both insert, turning the queue cap into a formality. One definition, two
 * writers.
 */
export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * D6 — the ACCESS SCOPE, computed at invite time and STORED as the record of the grant.
 *
 * `engagement` (the WHOLE retrospective envelope) requires ALL of:
 *   1. an ENGAGEMENT-grain primary context — a `project_discovery` / `request_interaction`
 *      meeting has no engagement envelope to grant, so it is always `meeting`;
 *   2. a CLIENT-side guest — the rule is defined against the CLIENT COMPANY's domains, and
 *      an expert-side colleague matching the client's domain would be a data anomaly, not a
 *      grant. Enforced explicitly rather than left to fall out;
 *   3. a CORPORATE domain — ⚠ THE FREEMAIL EXCLUSION IS LOAD-BEARING, NOT A DETAIL. A client
 *      company operating on gmail.com would otherwise grant whole-engagement access to every
 *      Gmail guest anyone typed. `classifyEmailDomain` routes through `isBlockedDomain`
 *      (`FREEMAIL_DOMAINS ∪ DISPOSABLE_DOMAINS`, ADR-1031 / BAL-344) — strictly stronger
 *      than the design prototype's freemail-only list, and the same rule as domain auto-join;
 *   4. an EXACT match against a LIVE `party_domains` row for the owning company. ⚠ The source
 *      of truth is that platform-wide registry, NEVER the prototype's single `CLIENT_DOMAIN`
 *      constant.
 *
 * Anything else → `meeting`, the safe default.
 *
 * ⚠ WHY STORED AND NOT RESOLVED AT READ TIME. The whole mitigation for a RETROSPECTIVE grant
 * is INFORMED CONSENT: the inviter is shown a specific sentence and acts on it. Resolving at
 * read time would let a later `party_domains` change silently WIDEN OR NARROW a grant the
 * inviter agreed to in different terms. The stored value plus `email_domain` is the evidence
 * that what was granted matches what was disclosed. It also keeps `party_domains` off the
 * recap read path entirely.
 */
interface ResolvedGuestScope {
  accessScope: GuestAccessScopeLabel;
  /**
   * Whether the address's domain matched a LIVE registered domain of the owning company —
   * i.e. WHY the scope came out as it did. Analytics only, and a BOOLEAN, never the domain.
   *
   * ⚠ FALSE WHENEVER THE DOMAIN WAS NOT CONSULTED (a freemail address, an expert-side guest,
   * a request-grain meeting). It answers "did being a colleague widen this grant?", which is
   * exactly the product question, and it can never be `true` while `accessScope` is
   * `meeting`.
   */
  sameDomain: boolean;
}

/**
 * ⚠ PURE, AND IT TAKES THE REGISTERED DOMAINS AS AN ARGUMENT RATHER THAN READING THEM.
 * `listByParty` is a per-COMPANY read, and the caller invites up to 8 guests at once — an
 * earlier version called it inside the per-guest map and issued 8 identical queries for one
 * request. The caller now reads once, conditionally, and passes the list in.
 */
function resolveGuestAccessScope(input: {
  email: string;
  party: MeetingGuestSide;
  contextType: PrimaryMeetingContext['contextType'];
  registeredDomains: ReadonlySet<string>;
}): ResolvedGuestScope {
  const narrow: ResolvedGuestScope = { accessScope: 'meeting', sameDomain: false };

  // (1) Request-grain contexts have no engagement envelope.
  if (input.contextType === 'project_discovery' || input.contextType === 'request_interaction') {
    return narrow;
  }
  // (2) The rule is about the CLIENT company's domains.
  if (input.party !== 'client') {
    return narrow;
  }
  // (3) Corporate only — the freemail/disposable exclusion.
  if (classifyEmailDomain(input.email) !== 'corporate') {
    return narrow;
  }
  const domain = extractEmailDomain(input.email);
  if (domain === null) {
    return narrow;
  }
  // (4) An exact match against a LIVE registered domain for this company.
  if (!input.registeredDomains.has(domain)) {
    return narrow;
  }
  return { accessScope: 'engagement', sameDomain: true };
}

/**
 * The owning company's live registered domains — read ONCE per invite request, and only when
 * the scope rule can actually reach step (4). A request-grain meeting or an expert-side
 * inviter can never widen a grant, so neither pays for the query.
 */
async function loadRegisteredDomains(input: {
  party: MeetingGuestSide;
  companyId: string;
  contextType: PrimaryMeetingContext['contextType'];
}): Promise<ReadonlySet<string>> {
  if (input.party !== 'client') return new Set();
  if (input.contextType === 'project_discovery' || input.contextType === 'request_interaction') {
    return new Set();
  }
  const rows = await partyDomainsRepository.listByParty('company', input.companyId);
  return new Set(rows.map((row) => row.domain));
}

/** `RESERVED_BASE_PARTICIPANTS` (delivering expert + booking client) + the live guests. */
async function participantCount(meetingId: string): Promise<number> {
  return RESERVED_BASE_PARTICIPANTS + (await meetingGuestsRepository.countLiveByMeeting(meetingId));
}

/**
 * The gate + the meeting-state check, in that order.
 *
 * ⚠ STATE IS CHECKED **AFTER** AUTHORIZATION, ALWAYS. Checking `meetings.status` first would
 * let an unauthorized caller distinguish a real ended meeting from a non-existent one by
 * status code — the oracle `authorize-meeting-participation`'s ordering rule exists to close.
 *
 * ⚠⚠ THIS IS FOR THE **ADDITIVE** MUTATIONS ONLY — `inviteGuests` and `decideGuestAdmission`.
 * `removeGuest` deliberately does NOT use it; see that function's docblock. Adding a third
 * caller means asking whether the operation still makes sense on an `ended` meeting, and for
 * REVOCATION the answer is emphatically yes.
 */
async function authorizeMutation(
  meetingId: string,
  actorUserId: string
): Promise<
  | { ok: true; authorized: Extract<AuthorizeMeetingParticipationResult, { ok: true }> }
  | { ok: false; code: GuestServiceErrorCode }
> {
  const authorized = await authorizeMeetingParticipation({ meetingId, userId: actorUserId });
  if (!authorized.ok) {
    return { ok: false, code: authorized.code };
  }
  if (MEETING_CLOSED_TO_GUESTS.has(authorized.meeting.status)) {
    log.info(
      { meetingId, actorUserId, status: authorized.meeting.status },
      'Guest mutation refused — meeting is closed to guests'
    );
    return { ok: false, code: 'meeting_not_open_for_guests' };
  }
  return { ok: true, authorized };
}

/**
 * Deduplicate an invite batch case-insensitively, PRESERVING FIRST-WINS ORDER.
 *
 * ⚠ MUST RUN BEFORE THE CAP COUNT. Counting the raw request array and inserting the
 * deduplicated one makes the two disagree: a body naming the same colleague three times
 * would consume three seats against the cap and create one row.
 */
function dedupeByEmail(guests: InviteGuestInput[]): InviteGuestInput[] {
  const seen = new Set<string>();
  const unique: InviteGuestInput[] = [];
  for (const guest of guests) {
    const email = canonicalEmail(guest.email);
    if (seen.has(email)) continue;
    seen.add(email);
    unique.push({ ...guest, email });
  }
  return unique;
}

interface AnnounceInvitesParams {
  rows: MeetingGuest[];
  rawTokensByGuestId: Map<string, string>;
  /** WHY each scope came out as it did — see `ResolvedGuestScope.sameDomain`. */
  sameDomainByGuestId: Map<string, boolean>;
  meetingTitle: string;
  scheduledStartIso: string;
  scheduledEndIso: string;
  inviterName: string;
  inviterOrgLabel: string;
  samePartyUserIds: string[];
  entryPoint: GuestInviteEntryPoint;
  actorUserId: string;
  contextType: PrimaryMeetingContext['contextType'];
}

/**
 * Publish ONE event, swallowing a queue failure into a log line.
 *
 * ⚠ THE SWALLOW IS THE POINT, not laziness. The guest rows are already durably committed by
 * the time anything is published (see the module docblock), so a Redis hiccup is an
 * undelivered email — a support case — not a failed invite. Throwing would 500 a request
 * whose database work fully succeeded and invite the caller to retry into a
 * `guest_already_invited`.
 *
 * ⚠ `context` MUST NEVER CARRY THE ADDRESS OR THE TOKEN. `correlationId` is whatever the
 * event's own payload uses as its dedup key — the guest row id on the invite/roster events,
 * and the ROTATED HASH PREFIX on `meeting.guest_link_resent` (see that payload's docblock for
 * why the two must differ). Either is enough to correlate a failure with a row; neither is a
 * secret.
 */
async function publishBestEffort(
  publish: () => Promise<unknown>,
  context: { event: string; correlationId: string },
  failureMessage: string
): Promise<void> {
  try {
    await publish();
  } catch (error) {
    log.error(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      failureMessage
    );
  }
}

/** The guest-facing invite email + the per-guest analytics event, for ONE committed row. */
async function announceOneInvite(params: AnnounceInvitesParams, row: MeetingGuest): Promise<void> {
  const rawToken = params.rawTokensByGuestId.get(row.id);
  if (rawToken === undefined) {
    // Structurally impossible — the map is built from the same list. Logged rather than
    // thrown: a committed guest with an unsendable email is a support case, not a 500.
    log.error({ guestId: row.id }, 'Guest invite committed without a mintable token');
    return;
  }

  await publishBestEffort(
    () =>
      notificationEvents.publish('meeting.guest_invited', {
        correlationId: row.id,
        recipientEmail: row.email,
        joinToken: rawToken,
        ...(row.name === null ? {} : { guestName: row.name }),
        inviterName: params.inviterName,
        inviterOrgLabel: params.inviterOrgLabel,
        meetingTitle: params.meetingTitle,
        scheduledStartIso: params.scheduledStartIso,
        scheduledEndIso: params.scheduledEndIso,
        accessScope: row.accessScope,
        expiresOn: formatExpiryDate(row.expiresAt),
      }),
    { event: 'meeting.guest_invited', correlationId: row.id },
    'Failed to publish guest invite notification — the invite itself is committed'
  );

  trackServer(GUEST_SERVER_EVENTS.GUEST_INVITED, {
    entry_point: params.entryPoint,
    party: row.party as MeetingGuestSide,
    participation_role: row.participationRole,
    access_scope: row.accessScope,
    // WHY the scope came out as it did — a boolean, never the domain.
    same_domain: params.sameDomainByGuestId.get(row.id) ?? false,
    context_type: params.contextType,
    distinct_id: params.actorUserId,
  });
}

/** The same-party in-app FYI for ONE committed row. */
async function announceOneRosterChange(
  params: AnnounceInvitesParams,
  row: MeetingGuest
): Promise<void> {
  const correlationId = `${row.meetingId}:${row.id}`;
  await publishBestEffort(
    () =>
      notificationEvents.publish('meeting.guest_added', {
        correlationId,
        recipientUserIds: params.samePartyUserIds,
        // ⚠ NAME ONLY. Falls back to the neutral noun, never to the address.
        guestDisplayName: row.name ?? 'A guest',
        meetingTitle: params.meetingTitle,
        scheduledStartIso: params.scheduledStartIso,
      }),
    { event: 'meeting.guest_added', correlationId },
    'Failed to publish guest-added FYI'
  );
}

/**
 * Publish the guest-facing invite email and the same-party roster FYI, then record
 * analytics. Best-effort: the rows are already committed (see the module docblock).
 *
 * ⚠ THE TWO PASSES ARE SEQUENTIAL AND SEPARATE, DELIBERATELY. Every guest's own invite goes
 * out before any roster FYI, so a queue failure part-way through cannot leave the party
 * notified about a colleague who never received their link.
 */
async function announceInvites(params: AnnounceInvitesParams): Promise<void> {
  for (const row of params.rows) {
    await announceOneInvite(params, row);
  }

  if (params.samePartyUserIds.length === 0) return;
  for (const row of params.rows) {
    await announceOneRosterChange(params, row);
  }
}

/** Pre-formatted UTC date for the email's helpful-fact expiry line ("13 August 2026"). */
function formatExpiryDate(expiresAt: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(expiresAt);
}

/**
 * What to call the meeting when its context carries no title of its own.
 *
 * ⚠ `meetings` HAS NO `title` COLUMN — verified, not assumed. The human name of a piece of
 * work lives on the engagement SUBTYPE (`case_engagements.title`) or on the originating
 * `project_requests.title`; the supertype `engagements` has neither. So a title is RESOLVED
 * per context type below, and these noun phrases are the honest fallback when the subtype
 * has no title to read. They are deliberately generic rather than invented: a guest-facing
 * email that names the wrong thing is worse than one that names the kind of thing.
 */
const MEETING_LABEL_FOR_CONTEXT: Record<PrimaryMeetingContext['contextType'], string> = {
  case: 'a consultation',
  project_kickoff: 'a project kickoff',
  package_session: 'a package session',
  retainer_checkin: 'a retainer check-in',
  project_discovery: 'a discovery call',
  request_interaction: 'an intro call',
};

/**
 * The meeting's human title, resolved from its PRIMARY context.
 *
 * One extra read on the INVITE and REMOVE paths only (never on list/admit/deny). Falls back
 * to `MEETING_LABEL_FOR_CONTEXT` whenever the subtype carries no title — which is the case
 * for `project_kickoff` / `package_session` / `retainer_checkin`, whose titles would need a
 * further hop through origination that is not worth a new repository surface here.
 */
async function resolveMeetingTitle(subject: PrimaryMeetingContext): Promise<string> {
  const fallback = MEETING_LABEL_FOR_CONTEXT[subject.contextType];
  try {
    if (subject.contextType === 'case') {
      const caseRow = await caseEngagementsRepository.findByEngagementId(subject.contextId);
      return caseRow?.title ?? fallback;
    }
    if (subject.contextType === 'project_discovery') {
      const request = await projectRequestsRepository.findById(subject.contextId);
      return request?.title ?? fallback;
    }
    if (subject.contextType === 'request_interaction') {
      const relationship = await requestExpertRelationshipsRepository.findById(subject.contextId);
      if (relationship === undefined) return fallback;
      const request = await projectRequestsRepository.findById(relationship.projectRequestId);
      return request?.title ?? fallback;
    }
  } catch (error) {
    // A title is COSMETIC. It must never fail an invite that is otherwise authorized and
    // valid — the generic label is a perfectly good email.
    log.warn(
      {
        contextType: subject.contextType,
        error: error instanceof Error ? error.message : String(error),
      },
      'Could not resolve a meeting title — falling back to the generic label'
    );
  }
  return fallback;
}

/** The inviter, named the way CLAUDE.md's attribution rule requires. */
interface InviterAttribution {
  /** RETROSPECTIVE person — "Dana". Falls back to a neutral noun, never to an email. */
  inviterName: string;
  /**
   * The ORG on first mention — the client company, or the agency.
   *
   * ⚠ EQUAL TO `inviterName` WHENEVER THERE IS NO SEPARATE PARTY TO NAME (an independent
   * expert; an unresolvable company or agency). Renderers MUST join the two with
   * `personWithOrgLabel` (`@balo/shared/parties`), which drops the "@ org" clause on
   * equality — a bare `${name} @ ${org}` renders "Dana Okoro @ Dana Okoro".
   *
   * ⚠ NEVER A PLACEHOLDER. An earlier version fell back to the literal `'their team'`,
   * which rendered "Dana Okoro @ their team" — indistinguishable from an unsubstituted
   * template variable, and worse than the bare name it was standing in for.
   */
  inviterOrgLabel: string;
}

/**
 * Resolve "Dana @ Northwind Industrial".
 *
 * ⚠ THE ORG HALF IS SIDE-DEPENDENT, PER CLAUDE.md's ATTRIBUTION RULE. A client-side inviter
 * is attributed to the client COMPANY. An expert-side inviter is attributed to their AGENCY
 * — and an INDEPENDENT expert (null `agencyId`) keeps their own name, which is the rule
 * stated verbatim in CLAUDE.md ("for agency-based experts, the agency … independent experts
 * keep their own name"). Never a bare "the expert".
 */
async function resolveInviterAttribution(
  actorUserId: string,
  side: MeetingGuestSide,
  companyId: string,
  expertProfileId: string | null
): Promise<InviterAttribution> {
  const user = await usersRepository.findById(actorUserId);
  const inviterName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'A colleague';

  if (side === 'client') {
    const company = await companiesRepository.findById(companyId);
    // ⚠ FALLS BACK TO THE PERSON, NOT TO A PLACEHOLDER — see `InviterAttribution`.
    return { inviterName, inviterOrgLabel: company?.name ?? inviterName };
  }

  if (expertProfileId !== null) {
    const profile = await expertsRepository.findProfileById(expertProfileId);
    if (profile?.agencyId != null) {
      const agency = await agenciesRepository.getSummaryById(profile.agencyId);
      if (agency !== undefined) {
        return { inviterName, inviterOrgLabel: agency.name };
      }
    }
  }
  // Independent expert (or an unresolvable agency): the person IS the party.
  return { inviterName, inviterOrgLabel: inviterName };
}

/**
 * Who gets the same-party "a guest was added" FYI.
 *
 * ⚠ THE SCHEMA HAS NO AUTHENTICATED-PARTICIPANT ROSTER, AND THIS SAYS SO RATHER THAN
 * PRETENDING OTHERWISE. `meeting_presence` records who ACTUALLY joined, after the fact, and
 * `meeting_guests` covers only non-users — so "the live participants of this meeting on your
 * side" is not a question the database can answer today. The closest honest audience is the
 * party's ADMINS (`MANAGE_MEMBERS` holders), i.e. the people accountable for who is in the
 * room, resolved through the existing `listAdminUserIds` so the role→capability map stays the
 * single place a role is interpreted (ADR-1029).
 *
 * ⚠ THE ACTOR IS EXCLUDED — they just pressed the button; telling them what they did is
 * noise (the `creatorIsDistinctMember` precedent).
 *
 * EXPERT-SIDE INVITES SKIP THIS ENTIRELY (`[]` ⇒ the dispatcher skips the fan-out): the
 * agency is not resolved on this path without a further hop, and an FYI to the CLIENT's
 * admins about the EXPERT's colleague would cross the party boundary that §8 forbids.
 * BAL-421 can widen it once a participant roster exists.
 */
async function resolveSamePartyRecipients(
  side: MeetingGuestSide,
  companyId: string,
  actorUserId: string
): Promise<string[]> {
  if (side !== 'client') return [];
  const admins = await partyMembershipsRepository.listAdminUserIds('company', companyId);
  return admins.filter((id) => id !== actorUserId);
}

/**
 * Invite one or more guests to a meeting.
 *
 * Sequence — every step ordered deliberately:
 *   gate + meeting state → dedupe → cap count → delegate refusal → per-guest scope + mint →
 *   ONE transactional write (+ audit rows) → publish → track.
 */
export async function inviteGuests(input: InviteGuestsInput): Promise<InviteGuestsResult> {
  const gate = await authorizeMutation(input.meetingId, input.actorUserId);
  if (!gate.ok) return { ok: false, code: gate.code };
  const { authorized } = gate;
  const { side, meeting, subject, companyId } = authorized;

  const guests = dedupeByEmail(input.guests);

  // ⚠ D4 — REFUSED HERE, BEFORE THE DB CHECK, so the caller gets a legible code rather than a
  // 500 from a raw `23514`. An expert-side DELEGATE is expert SUBSTITUTION by definition (the
  // booker a delegate replaces is the client), which is explicitly out of scope. The CHECK
  // `meeting_guest_delegate_is_client_side` is the BACKSTOP, not the UX.
  if (side === 'expert' && guests.some((guest) => guest.participationRole === 'delegate')) {
    log.warn(
      { meetingId: input.meetingId, actorUserId: input.actorUserId, side },
      'Guest invite refused — an expert-side delegate is expert substitution'
    );
    return { ok: false, code: 'delegate_must_be_client_side' };
  }

  // D8 — the cap. Counted AFTER dedupe so the count and the insert cannot disagree.
  const currentCount = await participantCount(input.meetingId);
  if (currentCount + guests.length > MAX_MEETING_PARTICIPANTS) {
    log.info(
      { meetingId: input.meetingId, currentCount, requested: guests.length },
      'Guest invite refused — participant cap reached'
    );
    return { ok: false, code: 'participant_cap_reached' };
  }

  const expiresAt = new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS);
  const rawTokensByEmail = new Map<string, string>();
  const sameDomainByEmail = new Map<string, boolean>();

  // ONE read for the whole batch, and only when the scope rule can reach step (4).
  const registeredDomains = await loadRegisteredDomains({
    party: side,
    companyId,
    contextType: subject.contextType,
  });

  const prepared = guests.map((guest) => {
    const email = guest.email;
    const { rawToken, tokenHash } = mintGuestInviteToken();
    rawTokensByEmail.set(email, rawToken);
    const { accessScope, sameDomain } = resolveGuestAccessScope({
      email,
      party: side,
      contextType: subject.contextType,
      registeredDomains,
    });
    sameDomainByEmail.set(email, sameDomain);
    return {
      email,
      name: guest.name?.trim() ?? null,
      emailDomain: extractEmailDomain(email),
      party: side,
      participationRole: guest.participationRole ?? ('guest' as const),
      accessScope,
      // Email-invited ⇒ someone with rights named this address ⇒ no host decision needed.
      // `link` / `pending` is BAL-132's lobby and has no producer here.
      inviteChannel: 'email' as const,
      admission: 'pre_admitted' as const,
      tokenHash,
      expiresAt,
    };
  });

  let rows: MeetingGuest[];
  try {
    rows = await meetingGuestsRepository.createMany({
      meetingId: input.meetingId,
      invitedById: input.actorUserId,
      guests: prepared,
    });
  } catch (error) {
    // The live `(meeting_id, party, email)` partial unique. Mapped rather than pre-checked,
    // because a pre-check races under READ COMMITTED.
    if (isUniqueViolation(error)) {
      // ⚠ NO EMAIL ADDRESS IN THIS LINE. The batch size and the meeting are enough to find
      // the collision from the roster; the address is the thing this feature conceals.
      log.warn(
        { meetingId: input.meetingId, actorUserId: input.actorUserId, batchSize: guests.length },
        'Guest invite refused — a live invite already exists for this party and address'
      );
      return { ok: false, code: 'guest_already_invited' };
    }
    throw error;
  }

  const rawTokensByGuestId = new Map(
    rows.flatMap((row) => {
      const token = rawTokensByEmail.get(row.email);
      return token === undefined ? [] : [[row.id, token] as const];
    })
  );

  // Independent reads — resolved concurrently so the announce step costs one round trip's
  // latency rather than three (the async-waterfall rule).
  const [meetingTitle, attribution, samePartyUserIds] = await Promise.all([
    resolveMeetingTitle(subject),
    resolveInviterAttribution(input.actorUserId, side, companyId, authorized.expertProfileId),
    resolveSamePartyRecipients(side, companyId, input.actorUserId),
  ]);

  await announceInvites({
    rows,
    rawTokensByGuestId,
    sameDomainByGuestId: new Map(
      rows.map((row) => [row.id, sameDomainByEmail.get(row.email) ?? false] as const)
    ),
    meetingTitle,
    scheduledStartIso: meeting.scheduledStart.toISOString(),
    scheduledEndIso: meeting.scheduledEnd.toISOString(),
    inviterName: attribution.inviterName,
    inviterOrgLabel: attribution.inviterOrgLabel,
    samePartyUserIds,
    entryPoint: input.entryPoint,
    actorUserId: input.actorUserId,
    contextType: subject.contextType,
  });

  return {
    ok: true,
    guests: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      party: row.party as MeetingGuestSide,
      participationRole: row.participationRole,
      accessScope: row.accessScope,
      admission: 'pre_admitted' as const,
      invitedAt: row.createdAt.toISOString(),
    })),
    participantCount: currentCount + rows.length,
    participantCap: MAX_MEETING_PARTICIPANTS,
  };
}

/**
 * The party-scoped roster, plus `canHost` for BAL-132.
 *
 * ⚠ EVERY ROW GOES THROUGH `projectGuestForViewer`. The repository's `MeetingGuestPublic`
 * carries `email`, `emailDomain` and `accessScope`, none of which may cross the party
 * boundary — see that projector's docblock. Serialising the repository shape directly is the
 * defect this call prevents.
 *
 * ⚠ `canHost` SHIPS HERE SO BAL-132 NEEDS NO NEW ENDPOINT, and so its admit/deny controls
 * gate on a server answer rather than on `lens === 'expert'` — the comparison ADR-1029
 * forbids and which the in-meeting design prototype does. It is `host_meetings` on the
 * ENGAGEMENT axis, deliberately a different token from the `manage_engagement` this route's
 * gate used: hosting is the live/in-meeting right, inviting is administrative.
 *
 * ── ⚠⚠ `participantCount` IS THE **SEAT** COUNT, FROM THE COUNTER THE CAP IS ENFORCED ON ──
 *
 * It is `participantCount()` → `countLiveByMeeting`, byte for byte the same call
 * `inviteGuests` gates on — NOT `rows.length`. That is not a refactor; the two disagreed.
 *
 * `listLiveByMeeting` filters `deleted_at` / `revoked_at` only, so it INCLUDES `pending`
 * knocks and expired handles, neither of which holds a seat. While BAL-408 was the only
 * writer nothing could produce a `pending` row and the two happened to agree. BAL-132 makes
 * them diverge in the worst direction: 2 admitted guests + 5 queued knocks reported
 * `participantCount: 9` of 10 while `inviteGuests` computed 4 and would accept 6 more. The
 * route's own contract instructs consumers to render "{n} of 10" from these two fields and
 * never a local count, so BAL-436's composer would have shown a nearly-full meeting and, if
 * it gated on `count >= cap`, disabled itself — reintroducing the invite lockout the counter
 * split exists to close, moved from the server to the client.
 *
 * ⚠ ONE RULE ANSWERS "HOW FULL IS THIS MEETING", AND IT IS THE ONE THE SERVER REFUSES ON.
 * Do not re-derive it from `rows` here, even with a matching predicate: two expressions of
 * one rule is how the rule stops being one.
 *
 * ⚠ QUEUE DEPTH IS A DIFFERENT QUESTION AND IS ALREADY ANSWERABLE — count
 * `guests[].admission === 'pending'`. `projectGuestForViewer` omits FIELDS across the party
 * boundary, never ROWS, so that count is complete for every viewer. It is deliberately NOT a
 * second top-level number: seats and queue slots are separate resources
 * (`MAX_MEETING_PARTICIPANTS` vs `MAX_LOBBY_QUEUE`) and conflating them in one payload is
 * exactly how they got conflated in the first place.
 */
export async function listGuests(input: {
  meetingId: string;
  actorUserId: string;
}): Promise<ListGuestsResult> {
  // ⚠ NO meeting-state check on the READ. An ENDED meeting's roster must stay readable — it
  // is the record of who was on the call — whereas inviting someone to a call that already
  // happened is meaningless. The same deliberate asymmetry `findLiveByTokenHash` documents.
  const authorized = await authorizeMeetingParticipation({
    meetingId: input.meetingId,
    userId: input.actorUserId,
  });
  if (!authorized.ok) return { ok: false, code: authorized.code };

  // Three independent reads — one round trip's latency, not three (the async-waterfall rule).
  const [rows, canHost, seatCount] = await Promise.all([
    meetingGuestsRepository.listLiveByMeeting(input.meetingId),
    hasEngagementCapability(
      { id: input.actorUserId },
      ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
      authorized.subject
    ),
    // ⚠ THE SAME FUNCTION `inviteGuests` GATES ON. See the docblock.
    participantCount(input.meetingId),
  ]);

  return {
    ok: true,
    guests: rows.map((row: MeetingGuestPublic) =>
      projectGuestForViewer(
        {
          id: row.id,
          email: row.email,
          emailDomain: row.emailDomain,
          name: row.name,
          party: row.party as MeetingGuestSide,
          participationRole: row.participationRole,
          accessScope: row.accessScope,
          admission: row.admission,
          // ⚠⚠ BAL-436 — BOTH ALREADY ON `MeetingGuestPublic` AND IN `PUBLIC_COLUMNS`. No
          // repository change, no new query, no migration. `inviteChannel` is what lets the
          // panel mark a `link` row UNVERIFIED without DERIVING it from `admission` (a 1:1
          // mapping today only by coincidence of the current writer set — see
          // `GuestForViewer.inviteChannel`), and it is ALSO what makes the projector's
          // `link` arm reachable, which is what stops a self-declared address crossing.
          inviteChannel: row.inviteChannel,
          admissionDecidedAt: row.admissionDecidedAt,
        },
        authorized.side
      )
    ),
    canHost,
    participantCount: seatCount,
    participantCap: MAX_MEETING_PARTICIPANTS,
  };
}

/**
 * Remove a guest: revoke + soft-delete + audit, then email that person and only that person.
 *
 * ⚠ THE SAME-PARTY RULE. An actor may remove only a guest whose `party` equals their own
 * resolved side — a client member must not be able to eject the expert's colleague, nor the
 * reverse. A cross-party attempt answers `guest_not_found`, IDENTICAL on the wire to a guest
 * id that does not exist, so the route is not an oracle for "does the other side have a guest
 * with this id".
 *
 * ⚠⚠ NO MEETING-STATE CHECK — THIS DELIBERATELY DOES NOT CALL `authorizeMutation`, AND THE
 * ASYMMETRY IS THE WHOLE POINT. `findLiveByTokenHash` keeps resolving for an `ended` meeting
 * for the full `GUEST_TOKEN_TTL_AFTER_END_MS` (7 days), so during that window the link is
 * still rendering the inviter, the counterparty org label and every other guest's name.
 * Routing removal through the terminal-set gate would answer `meeting_not_open_for_guests`
 * for those 7 days — i.e. there would be NO WAY TO SWITCH THE LINK OFF, which
 *   (a) breaks a promise the product makes in the invite email verbatim ("If your invitation
 *       is withdrawn, the link stops working straight away"), and
 *   (b) removes the revocability the retrospective `engagement` grant's informed-consent
 *       story depends on.
 * Revocation is the one guest mutation that must stay available for exactly as long as the
 * credential does. `cancelled` needs no special handling: `findLiveByTokenHash` already
 * excludes it, so the link is dead regardless.
 *
 * The gate below is still fail-closed and still tenancy-scoped — it is only the STATE check
 * that is dropped, exactly as `listGuests` drops it.
 */
export async function removeGuest(input: {
  meetingId: string;
  guestId: string;
  actorUserId: string;
}): Promise<RemoveGuestResult> {
  const authorized = await authorizeMeetingParticipation({
    meetingId: input.meetingId,
    userId: input.actorUserId,
  });
  if (!authorized.ok) return { ok: false, code: authorized.code };

  // `meetingId` is the tenancy scope already authorized, so a guest id belonging to another
  // meeting resolves to `undefined` rather than to somebody else's row.
  const guest = await meetingGuestsRepository.findLiveById(input.meetingId, input.guestId);
  if (guest === undefined || guest.party !== authorized.side) {
    log.warn(
      {
        meetingId: input.meetingId,
        guestId: input.guestId,
        actorUserId: input.actorUserId,
        reason: guest === undefined ? 'no_guest' : 'cross_party',
      },
      'Guest removal denied'
    );
    return { ok: false, code: 'guest_not_found' };
  }

  const revoked = await meetingGuestsRepository.revoke({
    guestId: input.guestId,
    revokedByUserId: input.actorUserId,
  });
  if (revoked === undefined) {
    // Lost a race with a concurrent removal. Same literal — the outcome the caller wanted
    // has happened either way, and a distinct code would only describe our own timing.
    return { ok: false, code: 'guest_not_found' };
  }

  try {
    await notificationEvents.publish('meeting.guest_removed', {
      correlationId: revoked.id,
      recipientEmail: revoked.email,
      ...(revoked.name === null ? {} : { guestName: revoked.name }),
      meetingTitle: await resolveMeetingTitle(authorized.subject),
      scheduledStartIso: authorized.meeting.scheduledStart.toISOString(),
    });
  } catch (error) {
    log.error(
      {
        event: 'meeting.guest_removed',
        correlationId: revoked.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to publish guest-removed notification — the revocation itself is committed'
    );
  }

  trackServer(GUEST_SERVER_EVENTS.GUEST_REMOVED, {
    party: revoked.party as MeetingGuestSide,
    access_scope: revoked.accessScope,
    // Did revocation actually take anything away, or was the link never opened?
    had_joined: revoked.accessCount > 0,
    distinct_id: input.actorUserId,
  });

  return { ok: true };
}

/**
 * Admit or deny a waiting guest.
 *
 * ⚠ TWO GATES, IN THIS ORDER, BOTH FAIL-CLOSED — and the second does NOT subsume the first.
 * `hasEngagementCapability`'s own header block says "NOTHING IN THIS FILE AUTHORIZES THE
 * READ": it answers whether the actor may HOST an already-identified context, never whether
 * they were entitled to know the context exists. So:
 *   1. `authorizeMeetingParticipation` — may this actor see this meeting at all (tenancy);
 *   2. `hasEngagementCapability(HOST_MEETINGS)` — may they host it (delivery identity).
 *
 * ⚠ `host_meetings`, NOT `manage_engagement`. Admitting someone into a live room is the
 * live/in-meeting right. The two tokens share a holder set today, and gating on the one that
 * MEANS this is what keeps that an implementation detail rather than a dependency.
 *
 * ⚠ ENGAGEMENT LIFECYCLE IS OURS, NOT BAL-413'S. That resolver never reads
 * `engagements.status`, so a `completed` engagement's expert still holds both tokens. The
 * `authorizeMutation` call above additionally requires a LIVE meeting.
 *
 * ⚠⚠ **LIVE AS OF BAL-132 — THIS IS NO LONGER AN INERT PATH.** It shipped inert only because
 * nothing could produce an `admission = 'pending'` row; BAL-132 IS that ticket, and
 * `meetingGuestsRepository.claimLobbyPlace` (the anonymous lobby knock) is that producer. Both
 * decisions are now genuinely reachable in production, and the `409 guest_not_pending` answer
 * is now the RACE outcome it was always meant to be rather than the only outcome.
 *
 * ⚠⚠ IT RE-CHECKS THE SEAT CAP ON THE **ADMIT** BRANCH ONLY. It is the second ADDITIVE
 * mutation and, since BAL-132 stopped a `pending` row from consuming a seat, the only one
 * that could otherwise walk a meeting past `MAX_MEETING_PARTICIPANTS` — 25 queued knocks
 * against 1 free seat is now an expressible state. A DENY is never refused for capacity: it
 * is the host's only control for clearing a flooded queue. See the inline block.
 *
 * ⚠⚠ **THE HOST'S UI LANDED IN BAL-436** — the in-call People panel, whose Admit / Deny
 * controls gate on `canHost` from the GET response. The security obligation this layer could
 * not discharge (a `link`-channel `pending` row's name and email are SELF-DECLARED BY AN
 * ANONYMOUS VISITOR — anyone with the meeting URL can knock as anyone) is now discharged at
 * the DATA LAYER rather than in JSX: `projectGuestForViewer`'s `link` arm omits `email`,
 * `emailDomain` and `accessScope` for EVERY viewer and never falls `displayName` back to the
 * address, so the panel cannot render it even by accident. The panel adds the UNVERIFIED
 * badge on top, keyed on `inviteChannel` and nothing else.
 */
export async function decideGuestAdmission(input: {
  meetingId: string;
  guestId: string;
  actorUserId: string;
  decision: 'admitted' | 'denied';
}): Promise<DecideAdmissionResult> {
  const gate = await authorizeMutation(input.meetingId, input.actorUserId);
  if (!gate.ok) return { ok: false, code: gate.code };
  const { authorized } = gate;

  const canHost = await hasEngagementCapability(
    { id: input.actorUserId },
    ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
    authorized.subject
  );
  if (!canHost) {
    log.warn(
      {
        meetingId: input.meetingId,
        guestId: input.guestId,
        actorUserId: input.actorUserId,
        reason: 'no_host_capability',
      },
      'Guest admission decision denied'
    );
    // Collapsed into the gate's literal: a non-holder learns nothing about the meeting.
    return { ok: false, code: 'meeting_not_found' };
  }

  const guest = await meetingGuestsRepository.findLiveById(input.meetingId, input.guestId);
  if (guest === undefined) {
    log.warn(
      { meetingId: input.meetingId, guestId: input.guestId, actorUserId: input.actorUserId },
      'Guest admission decision refused — no live guest with that id on this meeting'
    );
    return { ok: false, code: 'guest_not_found' };
  }

  // ── ⚠⚠ THE SEAT CAP, RE-CHECKED HERE — THE SECOND ADDITIVE PATH ────────────────────────
  //
  // `authorizeMutation`'s docblock names BOTH `inviteGuests` and this function as ADDITIVE
  // mutations, but only `inviteGuests` used to count. That was safe only while a `pending`
  // row consumed a seat: the queue could not then grow past the cap, so the cap bounded both
  // paths through one check. BAL-132's counter split ended that on purpose — `pending` no
  // longer holds a seat — so `MAX_LOBBY_QUEUE` (25) knocks can now queue against `1` free
  // seat, and admitting them one by one would have walked a 10-person meeting to 27 without
  // ever consulting the cap.
  //
  // ⚠ ADMIT ONLY. A DENY MUST NEVER BE REFUSED FOR CAPACITY — it is the host's only control
  // for clearing a flooded queue, and gating it on a full room would jam the one lever that
  // unjams the meeting. It also frees, rather than consumes, a queue slot.
  //
  // ⚠ `>=`, NOT `>`. Admitting takes the count from N to N+1, so N at the cap is already one
  // too many. The count is UNSYNCHRONISED with the write, exactly as `inviteGuests` documents
  // — two hosts admitting simultaneously at 9/10 can both pass. Accepted on the same terms:
  // the cap is a product number, not a safety property, and an advisory lock is not warranted.
  //
  // ⚠ SAFE AS A DISTINCT LITERAL. It is reachable strictly AFTER `authorizeMutation` and the
  // `host_meetings` check, so it confirms nothing to anyone who was not already entitled to
  // read this roster. Reused rather than newly invented: `participant_cap_reached` already
  // means exactly this, and a second literal for one fact would make the wire vocabulary
  // describe our call sites instead of the product.
  if (input.decision === 'admitted') {
    const currentCount = await participantCount(input.meetingId);
    if (currentCount >= MAX_MEETING_PARTICIPANTS) {
      log.info(
        {
          meetingId: input.meetingId,
          guestId: input.guestId,
          actorUserId: input.actorUserId,
          currentCount,
        },
        'Guest admission refused — participant cap reached'
      );
      return { ok: false, code: 'participant_cap_reached' };
    }
  }

  // Compare-and-set on `admission = 'pending'` inside the repository, so two racing hosts
  // cannot both record a decision.
  const decided = await meetingGuestsRepository.decideAdmission({
    guestId: input.guestId,
    decision: input.decision,
    deciderUserId: input.actorUserId,
  });
  if (decided === undefined || decided.admissionDecidedAt === null) {
    log.warn(
      {
        meetingId: input.meetingId,
        guestId: input.guestId,
        actorUserId: input.actorUserId,
        decision: input.decision,
        reason: decided === undefined ? 'not_pending' : 'unstamped_decision',
      },
      'Guest admission decision refused — the row was not pending'
    );
    return { ok: false, code: 'guest_not_pending' };
  }

  // ⚠ NO NOTIFICATION ON EITHER BRANCH, DELIBERATELY. The person is in the lobby watching the
  // UI: an email after a DENY is hostile and one after an ADMIT is redundant.
  trackServer(
    input.decision === 'admitted'
      ? GUEST_SERVER_EVENTS.GUEST_ADMITTED
      : GUEST_SERVER_EVENTS.GUEST_DENIED,
    {
      party: decided.party as MeetingGuestSide,
      // ⚠ BAL-132 — REQUIRED, and it is what makes `party` READABLE on these two events. A
      // `link`-channel row's `party` is a PLACEHOLDER (the lobby writer stores `client`
      // because the column is NOT NULL, not because a side was resolved), so without this
      // discriminator every admit/deny in PostHog looks like a client-side guest. Taken from
      // the DECIDED ROW, never from request input.
      invite_channel: decided.inviteChannel,
      distinct_id: input.actorUserId,
    }
  );

  return {
    ok: true,
    id: decided.id,
    admission: input.decision,
    decidedAt: decided.admissionDecidedAt.toISOString(),
  };
}

/**
 * BAL-436 — RE-SEND the join link to a guest who was ADMITTED and never arrived.
 *
 * The product case is narrow and real: a host admits somebody out of the waiting queue, the
 * person's tab has gone stale or their link was lost, and the host has no way to get them
 * back in. This mints a FRESH credential and emails it to the address on the row — never to
 * an address the caller names.
 *
 * ── ⚠⚠ ROTATION INVALIDATES THE PREVIOUS CREDENTIAL, AND THAT IS CORRECT ────────────────
 *
 * The host is re-sending precisely BECAUSE the previous credential is believed lost. Leaving
 * two live credentials on one row is a second hijack surface opened by the act of rescuing
 * somebody. **THIS RULING IS BAL-442'S INHERITANCE:** its guest self-service arm must call
 * THIS SAME FUNCTION behind a different actor gate, never a second rotation primitive.
 *
 * ── THE GATES, IN ORDER, BOTH FAIL-CLOSED ───────────────────────────────────────────────
 *
 *   1. `authorizeMeetingParticipation` — tenancy first, ALWAYS. The ordering rule is
 *      unchanged: checking anything about the meeting before authorization is an oracle.
 *   2. `hasEngagementCapability(HOST_MEETINGS)` — the SAME verdict the panel gated its button
 *      on, re-checked server-side. ⚠ A UI GATE IS NEVER THE GATE.
 *
 * ⚠ IT DOES **NOT** GO THROUGH `authorizeMutation`, and the reason is `removeGuest`'s
 * verbatim. A re-send is a repair for a meeting that is happening or has just happened; the
 * credential stays valid for `GUEST_TOKEN_TTL_AFTER_END_MS` past `scheduled_end`, so gating
 * on the terminal set would refuse the one action that fixes a stranded guest during the very
 * window the link is supposed to work in. The gate above is still tenancy-scoped and still
 * fail-closed — only the STATE check is dropped, exactly as `listGuests` and `removeGuest`
 * drop it.
 *
 * ⚠ EVERY REFUSAL AFTER THE GATES IS `guest_not_found` OR `guest_link_not_resendable`, AND
 * NEITHER IS A 403 — this surface has none (`guests.ts`). A nonexistent id, another meeting's
 * id and a revoked row are IDENTICAL on the wire, so the route is not an oracle.
 *
 * ⚠ NO SEAT-CAP CHECK. This is not an ADDITIVE mutation: an `admitted` guest already holds
 * their seat, and re-issuing their credential adds nobody to the room. Adding a cap check
 * here would refuse to rescue a stranded guest precisely when the meeting is full — i.e. when
 * their seat is already counted.
 */
export async function resendGuestJoinLink(input: {
  meetingId: string;
  guestId: string;
  actorUserId: string;
}): Promise<ResendGuestLinkResult> {
  const authorized = await authorizeMeetingParticipation({
    meetingId: input.meetingId,
    userId: input.actorUserId,
  });
  if (!authorized.ok) return { ok: false, code: authorized.code };

  const canHost = await hasEngagementCapability(
    { id: input.actorUserId },
    ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
    authorized.subject
  );
  if (!canHost) {
    log.warn(
      {
        meetingId: input.meetingId,
        guestId: input.guestId,
        actorUserId: input.actorUserId,
        reason: 'no_host_capability',
      },
      'Guest link re-send denied'
    );
    // Collapsed into the gate's literal: a non-holder learns nothing about the meeting.
    return { ok: false, code: 'meeting_not_found' };
  }

  // `meetingId` is the tenancy scope already authorized, so a guest id belonging to another
  // meeting resolves to `undefined` rather than to somebody else's row.
  const guest = await meetingGuestsRepository.findLiveById(input.meetingId, input.guestId);
  if (guest === undefined) {
    log.warn(
      { meetingId: input.meetingId, guestId: input.guestId, actorUserId: input.actorUserId },
      'Guest link re-send refused — no live guest with that id on this meeting'
    );
    return { ok: false, code: 'guest_not_found' };
  }

  // ⚠ THE NARROW SHAPE, AND BOTH HALVES MATTER. An `email` invitee has an inviter and a
  // remove-then-re-invite path, so rotating theirs here would bypass the attribution that
  // path records. A `pending` knock has not been let in at all — "re-send" would mint a
  // credential for somebody nobody has admitted, which is the single control the queue is.
  if (guest.inviteChannel !== 'link' || guest.admission !== 'admitted') {
    log.warn(
      {
        meetingId: input.meetingId,
        guestId: input.guestId,
        actorUserId: input.actorUserId,
        inviteChannel: guest.inviteChannel,
        admission: guest.admission,
      },
      'Guest link re-send refused — not an admitted link-channel guest'
    );
    return { ok: false, code: 'guest_link_not_resendable' };
  }

  // ⚠ MINT BEFORE PUBLISH, AND THE ROW IS WRITTEN BEFORE EITHER. See the module docblock —
  // publishing first would email a credential the database never accepted.
  const { rawToken, tokenHash } = mintGuestInviteToken();
  // ⚠ DERIVED FROM THE **MEETING**, never from the mint instant — the rule
  // `meeting_guests.expires_at` has no SQL default in order to enforce.
  const expiresAt = new Date(
    authorized.meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS
  );

  // ⚠⚠ THE REPOSITORY RE-STATES ALL FOUR NARROWING FACTS IN ITS OWN `WHERE` — meeting,
  // liveness, `link` and `admitted`. The reads above are for a PRECISE ERROR LITERAL, not for
  // safety: between them and this write a concurrent revoke can land, and this platform has no
  // RLS, so the statement's own clause has to be the boundary. Passing `meetingId` is what
  // makes that true rather than aspirational.
  const rotated = await meetingGuestsRepository.rotateToken({
    meetingId: input.meetingId,
    guestId: input.guestId,
    tokenHash,
    expiresAt,
    rotatedByUserId: input.actorUserId,
  });
  if (rotated === undefined) {
    // Lost a race with a concurrent revoke (or with a state change out of the narrow shape).
    // Same literal — a revoked row and a nonexistent one are the same answer to this caller,
    // and a distinct code would describe our timing.
    return { ok: false, code: 'guest_not_found' };
  }

  // Resolved BEFORE the publish thunk, not inside it: `publishBestEffort` takes a synchronous
  // factory, and a title lookup is a cosmetic read that must not sit inside the swallow.
  const meetingTitle = await resolveMeetingTitle(authorized.subject);

  await publishBestEffort(
    () =>
      notificationEvents.publish('meeting.guest_link_resent', {
        // ⚠⚠ **NOT THE ROW ID.** See `MeetingGuestLinkResentPayload.correlationId`: the
        // invite's jobId dedup key IS the row id, so reusing it here would collide with the
        // original invite's retained job and the re-send would be silently swallowed — the
        // exact failure this affordance exists to fix. The new hash's prefix is unique per
        // rotation, deterministic for a retry, and is not the raw token.
        correlationId: tokenHash.slice(0, 16),
        recipientEmail: rotated.email,
        joinToken: rawToken,
        ...(rotated.name === null ? {} : { guestName: rotated.name }),
        meetingTitle,
        scheduledStartIso: authorized.meeting.scheduledStart.toISOString(),
        scheduledEndIso: authorized.meeting.scheduledEnd.toISOString(),
        expiresOn: formatExpiryDate(rotated.expiresAt),
      }),
    { event: 'meeting.guest_link_resent', correlationId: tokenHash.slice(0, 16) },
    'Failed to publish guest link re-send — the rotation itself is committed'
  );

  trackServer(GUEST_SERVER_EVENTS.GUEST_LINK_RESENT, { distinct_id: input.actorUserId });

  // ⚠ A CREDENTIAL WAS ISSUED — that is a key business event, and it is the one line that
  // makes a "they never got it" support case answerable. ⚠ NO ADDRESS, NO TOKEN, NO HASH.
  log.info(
    { meetingId: input.meetingId, guestId: rotated.id, actorUserId: input.actorUserId },
    'Guest join link re-sent — the previous credential is now dead'
  );

  return { ok: true, id: rotated.id, expiresAt: rotated.expiresAt.toISOString() };
}
