import 'server-only';

import type {
  CasesIndexActionItemCounts,
  CasesIndexCaseRow,
  CasesIndexCounterparty,
  CasesIndexProductTag,
  CasesIndexResolvedRow,
  CasesIndexTrailMeeting,
  LiveRescheduleProposalSummary,
} from '@balo/db';
import {
  caseConsultationIsUpcoming,
  deriveCaseConsultationState,
  selectCaseNudge,
  type CaseNudge,
} from '@balo/shared/engagements';
import { rescheduleProposalIsLive } from '@balo/shared/meetings';
import { expertCounterpartyLabels } from '@/lib/meetings/expert-counterparty';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { initialsOf } from '@/app/(dashboard)/meetings/[meetingId]/_lib/resolve-counterparty';
import { resolveActorLabel } from '@/lib/cases/actor-attribution';
import { expertPartyDisplayName } from '@balo/shared/parties';
import {
  caseTrailMark,
  CASE_TRAIL_MAX_MARKS,
  resolveCaseCardState,
} from './cases-index-presentation';
import type {
  CaseTrailEntry,
  CasesIndexCardView,
  CasesIndexResolvedRowView,
  CasesIndexSide,
} from './cases-index-view-types';

/**
 * BAL-567 — repository rows + the page's BATCHED side reads → the client-safe card views.
 *
 * ⚠⚠ NOTHING HERE READS THE DATABASE. Every input is already fetched, in batches, over the whole
 * page (see `load-cases-index.ts`); this module is the projection step. A read added here would
 * be a read PER CARD, which is the one thing this index must never do.
 *
 * ⚠⚠ THE PROJECTION IS EXPLICIT, NEVER A SPREAD OF A REPOSITORY ROW. Excess-property checking
 * does not apply to spreads, so `{ ...row, href }` would carry every future column straight to
 * the browser. Each field below is named; `cases-index-view-types.test.ts` pins the resulting
 * key set exactly and walks the DTO for a money/secret denylist.
 *
 * ⚠ THE CARD STATE IS `selectCaseNudge`'s ANSWER, not a second opinion. The index and the case
 * page must agree about what a case is doing, and that function is where the priority ordering
 * lives ("the ask is suppressed while anything is booked" falls out of it).
 */

/**
 * `CasesIndexSide` (which WORKSPACE) → the side the case's own rules are expressed in (which
 * PARTY). A total lookup, never a branch.
 *
 * ⚠ THE TWO VOCABULARIES ARE GENUINELY DIFFERENT AND THE TRANSLATION BELONGS IN ONE PLACE. A
 * workspace is `company`/`expert`; an engagement side is `client`/`expert`. `selectCaseNudge`
 * and `resolveActorLabel` speak the second, and this is the only line that converts.
 *
 * ⚠⚠ IT IS NOT AN AUTHORIZATION INPUT. The workspace was chosen by `navWorkspaceTypeOf` and the
 * ACCESS decision was made by `resolveCompanyParticipation` before this module ran; this only
 * decides which party's copy and counts to render. `invariants/cases-index-no-view-gate.test.ts`
 * pins that nothing here ever COMPARES a side to authorize anything.
 */
const CASE_SIDE_BY_WORKSPACE: Readonly<Record<CasesIndexSide, 'client' | 'expert'>> = {
  company: 'client',
  expert: 'expert',
};

/** How many product tags may cross the wire. The card shows 1-2; the rest become "+N". */
const MAX_PRODUCT_TAGS = 6;

export interface CasesIndexCardContext {
  readonly side: CasesIndexSide;
  readonly viewerUserId: string;
  readonly now: Date;
  /** The whole page's consultation trail, keyed by engagement. */
  readonly trailByEngagement: ReadonlyMap<string, readonly CasesIndexTrailMeeting[]>;
  readonly tagsByEngagement: ReadonlyMap<string, readonly CasesIndexProductTag[]>;
  readonly actionItemsByEngagement: ReadonlyMap<string, CasesIndexActionItemCounts>;
  /** Engagement ids whose thread carries unread inbound activity for THIS viewer. */
  readonly unreadEngagementIds: ReadonlySet<string>;
  /** Every LIVE pending proposal across the page's meetings, keyed by meeting id. */
  readonly proposalByMeetingId: ReadonlyMap<string, LiveRescheduleProposalSummary>;
  /** `users.first_name` by id, for attribution. NAME COLUMNS ONLY — never an email. */
  readonly actorFirstNameById: ReadonlyMap<string, string | null>;
  /** The one case allowed to render Join, or `null`. See {@link CasesIndexCardView.joinPath}. */
  readonly featuredEngagementId: string | null;
}

/** The counterparty half, side-relative — resolved once so both list shapes agree on it. */
interface CounterpartyView {
  readonly counterpartyName: string;
  readonly counterpartyOrgLabel: string | null;
  readonly counterpartyAvatarUrl: string | null;
  readonly counterpartyInitials: string;
  readonly bookAgainHref: string | null;
}

/**
 * CLIENT SIDE → the delivering EXPERT (a person), their agency as the org line, their avatar, and
 * the one live forward destination (`/experts/{username}`).
 * EXPERT SIDE → the client PARTY, i.e. THE COMPANY.
 *
 * ⚠⚠ THE EXPERT SIDE NAMES THE COMPANY, NOT A PERSON, and that is CLAUDE.md's attribution rule
 * rather than a shortcut: PROSPECTIVE copy — who you are working with — names the PARTY, because
 * client-side rights sit on COMPANY membership (ADR-1029) and survive individual departures.
 * `load-case.ts` and `load-recap.ts` made the identical call; three surfaces disagreeing about
 * who the client IS would be worse than any of the three choices.
 *
 * ⚠ NO EXPERT-SIDE "Book again". Only a CLIENT can book, so the expert side has no destination.
 */
function resolveCounterparty(row: CasesIndexCounterparty, side: CasesIndexSide): CounterpartyView {
  if (side === 'expert') {
    return {
      counterpartyName: row.companyName,
      counterpartyOrgLabel: null,
      counterpartyAvatarUrl: null,
      counterpartyInitials: initialsOf(row.companyName),
      bookAgainHref: null,
    };
  }
  // BAL-566 (D7) — the ONE client-side expert-naming rule, shared with the dashboard and the
  // case page. "An expert" when every name column is null (a soft-deleted `users` row).
  const { personName, agencyLabel } = expertCounterpartyLabels({
    firstName: row.expertFirstName,
    lastName: row.expertLastName,
    agencyName: row.agencyName,
  });
  return {
    counterpartyName: personName,
    counterpartyOrgLabel: agencyLabel,
    // ⚠ `avatarUrl` MAY BE AN R2 KEY rather than a URL (Balo uploads store the key), so every
    // display site must run it through `getAvatarUrl` — this is that site.
    counterpartyAvatarUrl: getAvatarUrl(row.expertAvatarUrl, 'thumbnail'),
    counterpartyInitials: initialsOf(personName),
    // ⚠ `expert_profiles.username` IS NULLABLE. A null one means NO BUTTON — never a link to
    // `/experts/null`, and never a disabled CTA.
    bookAgainHref: row.expertUsername === null ? null : `/experts/${row.expertUsername}`,
  };
}

/**
 * The soonest consultation still expected to happen, from the page's already-fetched trail.
 *
 * ⚠ `caseConsultationIsUpcoming`, NOT A HAND-ROLLED STATUS LIST — it also admits
 * `pending_reschedule`, so a meeting carrying a live proposal is not dropped from the card's
 * next-consultation entirely while the ask is open. The identical rule `selectNextScheduled`
 * applies on the case page.
 */
function selectNextBooking(
  trail: readonly CasesIndexTrailMeeting[],
  proposalByMeetingId: ReadonlyMap<string, LiveRescheduleProposalSummary>
): CasesIndexTrailMeeting | null {
  const upcoming = trail
    .filter((meeting) =>
      caseConsultationIsUpcoming(
        deriveCaseConsultationState({
          status: meeting.status,
          outcome: meeting.outcome,
          hasLiveRescheduleProposal: proposalByMeetingId.has(meeting.meetingId),
        })
      )
    )
    .sort((a, b) => {
      const delta = a.scheduledStart.getTime() - b.scheduledStart.getTime();
      return delta === 0 ? a.meetingId.localeCompare(b.meetingId) : delta;
    });
  const [next] = upcoming;
  return next ?? null;
}

/**
 * The last `CASE_TRAIL_MAX_MARKS` marks, oldest first — the repository already orders the trail.
 *
 * ⚠ THE ORDINAL IS ASSIGNED BEFORE THE SLICE, so a case with nine consultations shows marks 4-9
 * and those marks keep their real numbers. It is what gives the rendered list a stable React key
 * that is not an array index (S6479).
 */
function buildTrail(
  trail: readonly CasesIndexTrailMeeting[],
  proposalByMeetingId: ReadonlyMap<string, LiveRescheduleProposalSummary>
): readonly CaseTrailEntry[] {
  return trail
    .map((meeting, position) => ({
      ordinal: position + 1,
      mark: caseTrailMark(
        deriveCaseConsultationState({
          status: meeting.status,
          outcome: meeting.outcome,
          hasLiveRescheduleProposal: proposalByMeetingId.has(meeting.meetingId),
        })
      ),
    }))
    .slice(-CASE_TRAIL_MAX_MARKS);
}

/**
 * WHOSE act this card is reporting, or `null`.
 *
 * ⚠ DRIVEN BY THE NUDGE KIND, NEVER BY WHICH COLUMNS HAPPEN TO BE POPULATED — the same rule
 * `load-case.ts`'s `nudgeActorUserId` follows, and for the same reason: a case can carry a live
 * proposal AND an outstanding ask at once, and only one of them is what the card is saying.
 */
function actorUserIdFor(
  nudge: CaseNudge,
  row: CasesIndexCaseRow,
  proposal: LiveRescheduleProposalSummary | null
): string | null {
  if (nudge === null) return null;
  if (nudge.kind === 'reschedule_proposal' || nudge.kind === 'reschedule_proposal_pending') {
    return proposal?.proposedByUserId ?? null;
  }
  if (nudge.kind === 'resolution_ask' || nudge.kind === 'resolution_ask_pending') {
    return row.resolutionRequestedByUserId;
  }
  return null;
}

/** ONE open case → its card view. */
function buildCard(row: CasesIndexCaseRow, context: CasesIndexCardContext): CasesIndexCardView {
  const caseSide = CASE_SIDE_BY_WORKSPACE[context.side];
  const trailMeetings = context.trailByEngagement.get(row.engagementId) ?? [];
  const nextBooking = selectNextBooking(trailMeetings, context.proposalByMeetingId);
  const proposal =
    nextBooking === null ? null : (context.proposalByMeetingId.get(nextBooking.meetingId) ?? null);

  // ⚠ `isOpen: true` IS A FACT ABOUT THE QUERY, NOT AN ASSUMPTION. `listOpenCases` filters
  // `case_engagements.closed_at IS NULL`; the resolved list has its own, much thinner shape.
  const nudge = selectCaseNudge({
    lens: caseSide,
    isOpen: true,
    nextScheduled:
      nextBooking === null
        ? null
        : { meetingId: nextBooking.meetingId, scheduledStart: nextBooking.scheduledStart },
    resolutionRequestedAt: row.resolutionRequestedAt,
    rescheduleProposal: proposal,
    now: context.now,
  });
  const trail = buildTrail(trailMeetings, context.proposalByMeetingId);
  // `selectCaseNudge` returns `null` only for a CLOSED case, which this list excludes — the
  // fallback names the state rather than narrowing with a `!`.
  const cardState = resolveCaseCardState(nudge?.kind ?? 'nothing_booked', trail.length);

  const actorUserId = actorUserIdFor(nudge, row, proposal);
  const actionItems = context.actionItemsByEngagement.get(row.engagementId);
  const isFeatured = context.featuredEngagementId === row.engagementId;

  return {
    engagementId: row.engagementId,
    href: `/cases/${row.engagementId}`,
    title: row.title,
    cardState,
    ...resolveCounterparty(row, context.side),
    productTags: (context.tagsByEngagement.get(row.engagementId) ?? [])
      .slice(0, MAX_PRODUCT_TAGS)
      .map((tag) => tag.name),
    trail,
    heldCount: row.heldCount,
    // The viewer's OWN side's open items — "{n} for you" must mean the reader.
    actionItemsForYou: actionItems === undefined ? 0 : actionItems[caseSide],
    unread: context.unreadEngagementIds.has(row.engagementId),
    openedAtIso: row.createdAt.toISOString(),
    nextBookingStartIso: nextBooking?.scheduledStart.toISOString() ?? null,
    nextBookingEndIso: nextBooking?.scheduledEnd.toISOString() ?? null,
    nextBookingStatus: nextBooking?.status ?? null,
    lastCallAtIso: row.lastHeldAt?.toISOString() ?? null,
    proposalOptionCount: proposal?.optionCount ?? null,
    actorLabel:
      actorUserId === null
        ? null
        : resolveActorLabel({
            side: caseSide,
            actorUserId,
            actorFirstName: context.actorFirstNameById.get(actorUserId) ?? null,
            viewerUserId: context.viewerUserId,
            deliveringExpertUserId: row.expertUserId,
            agencyName: row.agencyName,
            partyFallbackLabel: expertPartyShortOf(row),
          }),
    // ⚠ ONLY THE FEATURED CARD CARRIES A JOIN PATH, because only the featured card renders Join.
    // Every other card's meeting id therefore never leaves the server at all.
    joinPath: isFeatured && nextBooking !== null ? memberCallPath(nextBooking.meetingId) : null,
  };
}

/**
 * The expert PARTY's short label — the agency when they deliver through one, their own name when
 * independent. The ONE `expertPartyDisplayName` definition, never a re-derived branch.
 */
function expertPartyShortOf(row: CasesIndexCounterparty): string {
  return expertPartyDisplayName({
    type: row.expertType,
    agencyName: row.agencyName,
    firstName: row.expertFirstName,
    lastName: row.expertLastName,
  });
}

/**
 * A page of OPEN cases → card views, with the FEATURED case lifted out.
 *
 * ⚠ THE FEATURED CASE IS ROW 1 OF PAGE 1, AND ONLY IF IT HAS A BOOKING. The repository orders
 * `(bucket ASC, sortRank ASC, id ASC)` with `bucket = 0` meaning "has an upcoming booking", so
 * the soonest booked case is structurally first. Picking it here — rather than re-sorting — is
 * what keeps the ticket card and "show more" from disagreeing about the order.
 */
export function buildCasesIndexCards(
  rows: readonly CasesIndexCaseRow[],
  context: CasesIndexCardContext
): readonly CasesIndexCardView[] {
  return rows.map((row) => buildCard(row, context));
}

/** Which case (if any) may be promoted to the ticket card. `null` when nothing is booked. */
export function resolveFeaturedEngagementId(rows: readonly CasesIndexCaseRow[]): string | null {
  const [first] = rows;
  if (first === undefined || first.nextBookingAt === null) return null;
  return first.engagementId;
}

/**
 * A page of RESOLVED cases → row views. Deliberately thin: no trail, no unread, no tags — there
 * is nothing left to act on, so nothing extra is fetched or sent.
 */
export function buildCasesIndexResolvedRows(
  rows: readonly CasesIndexResolvedRow[],
  side: CasesIndexSide
): readonly CasesIndexResolvedRowView[] {
  return rows.map((row) => {
    const counterparty = resolveCounterparty(row, side);
    return {
      engagementId: row.engagementId,
      href: `/cases/${row.engagementId}`,
      title: row.title,
      counterpartyName: counterparty.counterpartyName,
      counterpartyOrgLabel: counterparty.counterpartyOrgLabel,
      closedAtIso: row.closedAt.toISOString(),
      closeReason: row.closeReason,
      heldCount: row.heldCount,
      bookAgainHref: counterparty.bookAgainHref,
    };
  });
}

/**
 * The LIVE pending proposals on a page's meetings, keyed by meeting id.
 *
 * ⚠ LIVENESS (EXPIRY) IS DECIDED HERE, ONCE, via `rescheduleProposalIsLive` — the repository
 * read filters `status = 'pending'` only, never expiry. Both the card state and the trail derive
 * from THIS map, so they cannot disagree about what "live" means (the `load-case.ts` rule).
 */
export function indexLiveProposals(
  proposals: readonly LiveRescheduleProposalSummary[],
  now: Date
): ReadonlyMap<string, LiveRescheduleProposalSummary> {
  const live = new Map<string, LiveRescheduleProposalSummary>();
  for (const proposal of proposals) {
    if (rescheduleProposalIsLive(proposal, now)) live.set(proposal.meetingId, proposal);
  }
  return live;
}
