import 'server-only';

import { cache } from 'react';
import {
  actionItemsRepository,
  agenciesRepository,
  caseEngagementsRepository,
  companiesRepository,
  conversationsRepository,
  creditSessionsRepository,
  expertsRepository,
  meetingContextsRepository,
  meetingGuestsRepository,
  partyDomainsRepository,
  rescheduleProposalsRepository,
  transcriptsRepository,
  usersRepository,
  type ActionItem,
  type CaseEngagementRow,
  type CaseExpertEarningsAggregate,
  type LiveRescheduleProposalSummary,
  type Meeting,
} from '@balo/db';
import { CAPABILITIES, ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import {
  MIN_MEETING_MINUTES,
  rescheduleProposalIsLive,
  resolveCancelRefusal,
} from '@balo/shared/meetings';
import { expertPartyDisplayName, personDisplayName } from '@balo/shared/parties';
import { expertCounterpartyLabels } from '@/lib/meetings/expert-counterparty';
import {
  caseConsultationIsUpcoming,
  deriveCaseConsultationState,
  selectCaseNudge,
  type CaseNudge,
} from '@balo/shared/engagements';
import { formatLongUtc } from '@/lib/format/utc-date';
import { errorMessage, log } from '@/lib/logging';
import { isRealtimeConfigured } from '@/lib/realtime/ably-server';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { hasCapability } from '@/lib/authz';
import { hasEngagementCapability } from '@/lib/authz/engagement';
import { resolveCaseAccess, type CaseAccess } from '@/lib/cases/resolve-case-access';
import { resolveActorLabel } from '@/lib/cases/actor-attribution';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { deriveConsultationOrdinal } from '@/lib/meetings/derive-consultation-ordinal';
import {
  mapConversationFileRowToView,
  mapMessageRowToView,
} from '@/lib/conversations/conversation-view';
import { mapActionItemNode, type ActionItemNodeView } from '@/lib/engagement/action-items-view';
import type {
  CaseActionItemsView,
  CaseConversationView,
  CaseEarningsView,
  CaseHeaderView,
  CaseNudgeView,
  CasePartyView,
  CasePersonView,
  CaseRescheduleProposalView,
  CaseSurfaceView,
} from '@/lib/cases/case-view-types';
import { mapCaseConsultations } from './map-case-consultations';
import { loadCaseFiles, type CaseFileMeetingRef } from './load-case-files';

/**
 * BAL-421 — THE CASE SURFACE'S SINGLE LOADER. Assembles one lens-aware payload from the
 * already-shipped primitives (the engagement conversation gate, the meeting-context seam,
 * action items, both file tables, and the engagement-grain earnings aggregate).
 *
 * ⚠ `cache()`-WRAPPED so `generateMetadata` and the page body share ONE set of reads per
 * render (React dedupes within a single server request) — the `load-recap.ts` precedent.
 * `generateMetadata` re-runs the FULL gate through this loader before specialising the title,
 * because Next streams the document title even when the body `notFound()`s.
 *
 * ── ⚠⚠ THE ORDER OF THE FIRST THREE STEPS IS THE TENANCY CONTRACT (BAL-129) ───────────────
 *
 *   1. `resolveCaseAccess` — MEMBERSHIP / VISIBILITY, resolved from the engagement's OWN row.
 *   2. `findByEngagementId` — the case-TYPE coherence check, which filters
 *      `engagement_type = 'case'` and both `deleted_at`s.
 *   3. ONLY THEN may `engagementId` be passed to `listMeetingsForContext` or to any
 *      conversation read.
 *
 * ⚠⚠ STEP 2 SITS **AFTER** STEP 1 SO THAT IT CAN NEVER BE AN EXISTENCE ORACLE. Both
 * `meeting_contexts.context_id` and `conversation_contexts.context_id` have NO FK and NO RLS,
 * so an unchecked id from the URL resolves to another tenant's rows and every read below would
 * return them verbatim. Running the coherence check first would additionally let a stranger
 * distinguish "a project engagement" from "someone else's case" from "no such uuid" by
 * response alone. A PROJECT engagement id and a CROSS-TENANT id produce the SAME `null` here,
 * and the page answers ONE `notFound()` with ONE copy.
 *
 * ⚠ NO MEETING ROW CROSSES TO THE CLIENT. `listMeetingsForContext` returns FULL `Meeting`
 * rows carrying `dailyRoomName` and `joinUrl`; they are consumed here and narrowed by
 * `mapCaseConsultations` (the projection boundary), and never composed into the view.
 *
 * ⚠ EVERY COUNTERPARTY READ IS COLUMN-PROJECTED AT THE REPOSITORY, NOT NARROWED HERE —
 * `findNameById`, `findDisplayProfileById`, `findDisplayById`, `findNamesByIds`,
 * `getSummaryById`. That is what makes it structurally impossible for this loader to be
 * holding `users.email`, `users.workosId` or `expert_profiles.rate_cents` in the first place.
 * `rate_cents` matters most: it is the UN-MARKED-UP consultant rate, and handing a client lens
 * a payload containing it would leak the Balo margin. Concealment is enforced by what the ROWS
 * can hold, never by remembering to omit things downstream.
 */

/** The conversation's first page. Matches the project stage's page size. */
const MESSAGE_PAGE_SIZE = 30;

/** Up to two initials for an avatar fallback. NEVER derived from an email address. */
function initialsOf(name: string): string {
  const [first, second] = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (first === undefined) return '?';
  return (first.charAt(0) + (second?.charAt(0) ?? '')).toUpperCase();
}

/** The neutral note a CLOSED case renders. `null` while open. Copy is the design reference's. */
function resolveClosedNote(caseRow: CaseEngagementRow): string | null {
  const { closedAt } = caseRow;
  if (closedAt === null) return null;
  if (caseRow.closeReason === 'auto_inactive') {
    return 'Closed automatically after 30 days without activity. Everything stays available.';
  }
  return 'Marked resolved on ' + formatLongUtc(closedAt) + '. Everything here stays available.';
}

/**
 * `CaseExpertEarningsAggregate` → `CaseEarningsView`. A PASS-THROUGH that preserves the
 * DISCRIMINANT arm for arm.
 *
 * ⚠⚠ THE THREE ARMS ARE REBUILT EXPLICITLY RATHER THAN SPREAD, SO THE FIGURE STAYS
 * STRUCTURALLY UNREPRESENTABLE UNTIL SOMETHING FINALIZES.
 *
 * ⚠⚠ BAL-466 (F9, review fix round) — CORRECTING A NOW-FALSE CLAIM. This used to say "Nothing
 * writes `credit_sessions.engagement_id` yet (BAL-400 will), so EVERY case on `main` today
 * returns `not_yet`". `openSession` writes it now, for every session BAL-466's admission seam
 * opens — so `pending` (and eventually `finalized`) are LIVE for a case with an admitted
 * client, reachable from this same read while the consultation is still on the call. A flat
 * `{state, number}` shape would still render "A$0.00", a MONEY CLAIM, for every expert on the
 * platform the moment that became possible — which is exactly why the three arms stay rebuilt
 * explicitly rather than spread. A `finalized` block CAN legitimately be `0`; that is a REAL
 * zero, which is exactly why the states must stay distinct.
 */
function toEarningsView(aggregate: CaseExpertEarningsAggregate): CaseEarningsView {
  if (aggregate.state === 'finalized') {
    return {
      state: 'finalized',
      earningsAudMinor: aggregate.earningsAudMinor,
      finalizedCount: aggregate.finalizedSessionCount,
      pendingCount: aggregate.pendingSessionCount,
    };
  }
  if (aggregate.state === 'pending') {
    return {
      state: 'pending',
      earningsAudMinor: null,
      finalizedCount: 0,
      pendingCount: aggregate.pendingSessionCount,
    };
  }
  return { state: 'not_yet', earningsAudMinor: null, finalizedCount: 0, pendingCount: 0 };
}

/** BAL-411 — the live proposal's own detail, fetched separately (see `loadCase`'s comment on
 *  WHY: `CaseNudge`'s shared core deliberately carries only `optionCount`). `null` unless
 *  `nudge.kind` is one of the two proposal arms. */
interface RescheduleProposalDetailForNudge {
  readonly createdAt: Date;
  readonly options: readonly { id: string; scheduledStart: Date }[];
}

/**
 * BAL-411 — resolves the live reschedule proposal (if any) on the case's `nextScheduled`
 * meeting, PLUS its detail (options + when it was made). Extracted out of `loadCase` to keep
 * that function's own cognitive complexity under the SonarJS ceiling — see the comment at the
 * call site for the "why a proposal-with-null-detail collapses to no proposal at all" rule this
 * preserves unchanged.
 */
async function resolveRescheduleProposalForNudge(
  nextScheduled: { meetingId: string; scheduledStart: Date; scheduledEnd: Date } | null,
  liveProposals: readonly LiveRescheduleProposalSummary[],
  now: Date
): Promise<{
  // ⚠ BAL-567 WIDENED THIS FROM `CaseNudgeRescheduleProposal` TO THE REPOSITORY'S OWN SUMMARY.
  // The shared core's shape deliberately carries only what `selectCaseNudge` reads, and
  // `proposedByUserId` is not that — it is ATTRIBUTION, never a capability input. Narrowing here
  // would have thrown the proposer away and forced a second lookup back into `liveProposals` at
  // the call site to get it again.
  proposal: LiveRescheduleProposalSummary | null;
  detail: RescheduleProposalDetailForNudge | null;
}> {
  if (nextScheduled === null) {
    return { proposal: null, detail: null };
  }
  const proposal =
    liveProposals.find(
      (candidate) =>
        candidate.meetingId === nextScheduled.meetingId && rescheduleProposalIsLive(candidate, now)
    ) ?? null;
  if (proposal === null) {
    return { proposal: null, detail: null };
  }
  const found = await rescheduleProposalsRepository.findPendingForAnswer({
    proposalId: proposal.proposalId,
    meetingId: proposal.meetingId,
  });
  if (found === undefined) {
    return { proposal, detail: null };
  }
  return {
    proposal,
    detail: {
      createdAt: found.proposal.createdAt,
      options: found.options.map((option) => ({
        id: option.id,
        scheduledStart: option.scheduledStart,
      })),
    },
  };
}

/**
 * `CaseNudge` (Dates, from the pure core) → `CaseNudgeView` (ISO strings, serialisable).
 *
 * BAL-409 — `nextScheduled` is passed through SEPARATELY (rather than widening `CaseNudge`
 * itself) so the reschedule dialog can read the meeting's current duration. Structurally,
 * `nudge.kind === 'upcoming'` implies `selectCaseNudge` derived it FROM this same
 * `nextScheduled` value, so it is never null there — the `?? MIN_MEETING_MINUTES` fallback is
 * defensive only, never reachable in practice.
 */
function toNudgeView(
  nudge: CaseNudge,
  nextScheduled: { meetingId: string; scheduledStart: Date; scheduledEnd: Date } | null,
  /**
   * BAL-567 — WHO acted, already resolved by `resolveActorLabel`. Required rather than
   * optional: the four attributed arms cannot be constructed without it (see `CaseNudgeView`).
   */
  actorLabel: string,
  /** BAL-574 — the SAME `now` `selectCaseNudge` used to decide `nudge.live`, projected onto
   *  the `'upcoming'` arm as `serverNowIso`. One `now`, read once, feeding both fields off the
   *  same object literal — see `CaseNudgeView`'s docblock. */
  now: Date
): CaseNudgeView {
  if (nudge === null) return null;
  if (nudge.kind === 'upcoming') {
    const durationMinutes =
      nextScheduled !== null && nextScheduled.meetingId === nudge.meetingId
        ? Math.round(
            (nextScheduled.scheduledEnd.getTime() - nextScheduled.scheduledStart.getTime()) / 60_000
          )
        : MIN_MEETING_MINUTES;
    return {
      kind: 'upcoming',
      meetingId: nudge.meetingId,
      scheduledStartIso: nudge.scheduledStart.toISOString(),
      live: nudge.live,
      serverNowIso: now.toISOString(),
      durationMinutes,
      // BAL-567 — the member call route, built SERVER-SIDE from an id this arm already carries.
      // `memberCallPath` is the ONE builder (`memberJoinPath`, the anonymous lobby, is deleted).
      joinPath: memberCallPath(nudge.meetingId),
    };
  }
  if (nudge.kind === 'reschedule_proposal') {
    return {
      kind: 'reschedule_proposal',
      proposalId: nudge.proposalId,
      meetingId: nudge.meetingId,
      optionCount: nudge.optionCount,
      originalScheduledStartIso: nudge.originalScheduledStart.toISOString(),
      expiresAtIso: nudge.expiresAt.toISOString(),
      actorLabel,
    };
  }
  if (nudge.kind === 'reschedule_proposal_pending') {
    return {
      kind: 'reschedule_proposal_pending',
      proposalId: nudge.proposalId,
      meetingId: nudge.meetingId,
      optionCount: nudge.optionCount,
      expiresAtIso: nudge.expiresAt.toISOString(),
      actorLabel,
    };
  }
  // ⚠ `nothing_booked` CARRIES NO ATTRIBUTION — nobody acted. Spelled as its own arm rather than
  // spreading `actorLabel` onto every remaining kind, so the field cannot leak onto a nudge that
  // has no actor to name.
  if (nudge.kind === 'nothing_booked') {
    return { kind: 'nothing_booked' };
  }
  return { kind: nudge.kind, actorLabel };
}

/**
 * BAL-567 — WHOSE act this nudge is reporting, as a user id or `null`.
 *
 * ⚠ DRIVEN BY THE NUDGE KIND, NEVER BY WHICH COLUMNS HAPPEN TO BE POPULATED. A case can carry a
 * live reschedule proposal AND an outstanding resolution request at the same time;
 * `selectCaseNudge` has already decided which one the header reports, and reading "whichever
 * column is non-null" here would attribute the wrong act to the wrong person.
 *
 * ⚠ `proposedByUserId` IS ATTRIBUTION, NEVER AUTHORIZATION. Nothing gates on it — the act axis
 * is `hasEngagementCapability` (ADR-1046), resolved from the engagement's delivery identity.
 */
function nudgeActorUserId(
  nudge: CaseNudge,
  caseRow: CaseEngagementRow,
  proposal: LiveRescheduleProposalSummary | null
): string | null {
  if (nudge === null) return null;
  if (nudge.kind === 'reschedule_proposal' || nudge.kind === 'reschedule_proposal_pending') {
    return proposal?.proposedByUserId ?? null;
  }
  if (nudge.kind === 'resolution_ask' || nudge.kind === 'resolution_ask_pending') {
    return caseRow.resolutionRequestedByUserId;
  }
  return null;
}

/**
 * BAL-567 — the actor's rendered label, through the ONE shared rule (`resolveActorLabel`).
 *
 * ⚠ NO ACTOR ⇒ NO QUERY. The overwhelming majority of cases carry neither a live proposal nor
 * an outstanding ask, and this returns the party label without touching the database.
 *
 * ⚠ NAME COLUMNS ONLY (ADR-1044). `findNamesByIds` projects `id`/`firstName`/`lastName` and
 * nothing else — never `email`, never `workosId`. Do not "upgrade" this to `findById`.
 */
async function resolveNudgeActorLabel(input: {
  actorUserId: string | null;
  lens: 'client' | 'expert';
  viewerUserId: string;
  deliveringExpertUserId: string | null;
  agencyName: string | null;
  partyFallbackLabel: string;
}): Promise<string> {
  const { actorUserId } = input;
  if (actorUserId === null) return input.partyFallbackLabel;

  const [actor] = await usersRepository.findNamesByIds([actorUserId]);
  return resolveActorLabel({
    side: input.lens,
    actorUserId,
    actorFirstName: actor?.firstName ?? null,
    viewerUserId: input.viewerUserId,
    // ⚠ `''` RATHER THAN THE ACTOR'S OWN ID when the expert profile's user row could not be
    // read: an empty string matches no uuid, so the client arm falls to "{name} @ {agency}"
    // instead of silently claiming the actor IS the delivering expert.
    deliveringExpertUserId: input.deliveringExpertUserId ?? '',
    agencyName: input.agencyName,
    partyFallbackLabel: input.partyFallbackLabel,
  });
}

/** Group action items into the three lens-relative buckets. */
function buildActionItems(
  items: readonly ActionItem[],
  lens: 'client' | 'expert',
  clientCompanyName: string,
  expertPartyShort: string,
  counterpartyLabel: string,
  nowMs: number
): CaseActionItemsView {
  const yours: ActionItemNodeView[] = [];
  const theirs: ActionItemNodeView[] = [];
  const unassigned: ActionItemNodeView[] = [];

  for (const item of items) {
    // ⚠ `mapActionItemNode` IS REUSED, NEVER RE-SPELLED. `mapActionItemsToView` (the panel
    // mapper beside it) is DELIBERATELY project-only — it calls `deriveEngagementParties`,
    // which needs the project hydration graph, and its `canWrite` reads the 4-value PROJECT
    // delivery status. Its own docblock assigns the case panel to this ticket and says to
    // reuse the per-item mapper.
    const node = mapActionItemNode(item, clientCompanyName, expertPartyShort, nowMs);
    if (item.assigneeParty === null) {
      unassigned.push(node);
    } else if (item.assigneeParty === lens) {
      yours.push(node);
    } else {
      theirs.push(node);
    }
  }

  return {
    yours,
    theirs,
    unassigned,
    counterpartyLabel,
    doneCount: items.filter((item) => item.status === 'done').length,
    totalCount: items.length,
  };
}

/** The counterparty labels both lenses need, resolved once. */
interface CounterpartyLabels {
  party: CasePartyView;
  /** Prospective PARTY short label — the expert's agency, or their own name if independent. */
  expertPartyShort: string;
  /** What the conversation composer and the "Theirs" action-item heading address. */
  counterpartyName: string;
  counterpartyFirstName: string;
  /**
   * ⚠ THE PROSPECTIVE COUNTERPARTY *PARTY* LABEL, LENS-RELATIVE — never a person on the client
   * lens. CLAUDE.md's attribution-by-tense rule: prospective copy ("X will see the slot open up
   * again") names the PARTY — the agency for an agency-delivered case, the person's own name only
   * for an independent expert. It is DERIVED FROM `expertPartyShort`, i.e. from the single
   * `expertPartyDisplayName` definition in `@balo/shared/parties` — do NOT re-derive the
   * agency-vs-person branch here or anywhere else. `counterpartyFirstName` above stays a bare
   * first name and belongs to the conversation's person-addressed register ("chat with Alex").
   */
  counterpartyPartyLabel: string;
  /** The org line under the case title: the agency (client lens) or the company (expert). */
  counterpartyOrgLabel: string;
  /**
   * BAL-567 — the delivering expert's AGENCY name, or `null` for an INDEPENDENT expert.
   *
   * ⚠ THE RAW AGENCY, NOT `counterpartyOrgLabel`. That one coalesces to `expertPartyShort` on
   * the client lens and to the client company on the expert lens, so it cannot answer "is there
   * a separate org to name after this person?" — which is exactly what `resolveActorLabel`'s
   * "{First name} @ {Agency}" arm asks. Both lenses carry it, because the attributed actor is
   * always EXPERT-SIDE on both.
   */
  agencyLabel: string | null;
}

/**
 * The rail's party card, both lenses.
 *
 * CLIENT LENS → the delivering EXPERT: avatar, person name, headline, agency, and the one
 * live forward destination (`/experts/{username}`).
 *
 * EXPERT LENS → the client PARTY, i.e. THE COMPANY.
 *
 * ⚠⚠ THE EXPERT LENS NAMES THE COMPANY, NOT A PERSON, AND THAT IS A DELIBERATE DEPARTURE FROM
 * THE DESIGN REFERENCE'S FIXTURE (which draws "Jordan Lee · Northwind Industrial"). CLAUDE.md's
 * attribution rule is explicit that PROSPECTIVE copy — who you are working with, who can act —
 * names the PARTY, because client-side rights sit on COMPANY membership (ADR-1029) and survive
 * individual departures. There is no `created_by_user_id` on an engagement to name a single
 * client person from anyway, and naming whoever happened to book would be wrong the moment
 * they left. `load-recap.ts`'s `resolveCounterparty` made the identical call for the identical
 * reason; two surfaces disagreeing about who the client IS would be worse than either choice.
 *
 * ⚠⚠ THE RATING IS ON THE CLIENT BRANCH ONLY (BAL-422). `expert_profiles.rating_average` /
 * `rating_count` now exist and `findDisplayProfileById` projects them, so the client lens
 * carries the delivering expert's real aggregate — the design reference's stars, backed by
 * data rather than faked. The EXPERT branch below hardcodes `ratingAverage: null` /
 * `ratingCount: 0` and MUST KEEP DOING SO: its counterparty is the client COMPANY, and
 * nothing evaluative belongs there — the expert is not scoring the client. This is enforced
 * by what each branch populates, and asserted by the lens tests.
 *
 * ⚠ `null` means NO REVIEWS, never 0.0 — the card null-gates on `ratingAverage` and renders
 * nothing rather than a fabricated zero.
 */
async function resolveCounterparty(
  lens: 'client' | 'expert',
  profile: Awaited<ReturnType<typeof expertsRepository.findDisplayProfileById>>,
  clientCompanyName: string
): Promise<CounterpartyLabels> {
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);

  const firstName = expertUser?.firstName ?? null;
  const lastName = expertUser?.lastName ?? null;
  // BAL-566 (D7) — the shared client-side expert-naming rule.
  const { personName: expertPerson, agencyLabel } = expertCounterpartyLabels({
    firstName,
    lastName,
    agencyName: agency?.name ?? null,
  });
  const expertPartyShort = expertPartyDisplayName({
    type: profile?.type ?? 'freelancer',
    agencyName: agencyLabel,
    firstName,
    lastName,
  });

  if (lens === 'client') {
    // ⚠ `expert_profiles.username` IS NULLABLE. A null username means NO CTA at all — never a
    // disabled button, and never an href pointing at `/experts/null`.
    const username = profile?.username ?? null;
    return {
      expertPartyShort,
      counterpartyName: expertPerson,
      counterpartyFirstName: personDisplayName(firstName, null, expertPartyShort),
      // The expert PARTY — the agency when they deliver through one, their own name when
      // independent. Already resolved by `expertPartyDisplayName` above; reused, never re-derived.
      counterpartyPartyLabel: expertPartyShort,
      counterpartyOrgLabel: agencyLabel ?? expertPartyShort,
      agencyLabel,
      party: {
        name: expertPerson,
        headline: profile?.headline ?? null,
        orgLabel: agencyLabel,
        avatarUrl: expertUser?.avatarUrl ?? null,
        initials: initialsOf(expertPerson),
        bookAgainHref: username === null ? null : '/experts/' + username,
        // BAL-422 — already parsed to a number by `findDisplayProfileById`.
        ratingAverage: profile?.ratingAverage ?? null,
        ratingCount: profile?.ratingCount ?? 0,
      },
    };
  }

  return {
    expertPartyShort,
    counterpartyName: clientCompanyName,
    counterpartyFirstName: clientCompanyName,
    // The expert lens's counterparty IS the client COMPANY — already a party, never a person
    // (see this function's docblock on the deliberate departure from the design fixture).
    counterpartyPartyLabel: clientCompanyName,
    counterpartyOrgLabel: clientCompanyName,
    // The delivering expert's agency, on the EXPERT lens too — see the field's docblock.
    agencyLabel,
    party: {
      name: clientCompanyName,
      headline: null,
      orgLabel: null,
      avatarUrl: null,
      initials: initialsOf(clientCompanyName),
      // ⚠ NO expert-side CTA. "Book another" is the CLIENT's action (only a client can book),
      // and every other expert-side forward action the design considered has no destination.
      bookAgainHref: null,
      // ⚠⚠ NOTHING EVALUATIVE ON THE EXPERT LENS (BAL-422). The counterparty here is the
      // client COMPANY; the expert does not score the client, and companies carry no rating
      // aggregate in the first place. Hardcoded, not derived — do not "wire" these.
      ratingAverage: null,
      ratingCount: 0,
    },
  };
}

/** The conversation region's first page, plus the labels its composer and list need. */
async function buildConversation(
  access: CaseAccess,
  labels: CounterpartyLabels,
  page: Awaited<ReturnType<typeof conversationsRepository.listMessagesPage>>,
  fileRows: Awaited<ReturnType<typeof conversationsRepository.listFiles>>
): Promise<CaseConversationView> {
  // ONE batched query over the distinct uploader set — never one per file.
  const uploaderIds = [...new Set(fileRows.map((row) => row.uploadedByUserId))];
  const people = uploaderIds.length === 0 ? [] : await usersRepository.findNamesByIds(uploaderIds);
  const nameById = new Map(
    people.map((person) => [
      person.id,
      personDisplayName(person.firstName, person.lastName, 'Participant'),
    ])
  );

  return {
    conversationId: access.conversationId,
    // Resolved ONCE at the gate. A CLOSED case is read-only but stays fully READABLE.
    writable: access.conversationWritable,
    counterpartyFirstName: labels.counterpartyFirstName,
    counterpartyName: labels.counterpartyName,
    initialMessages: page.messages.map(mapMessageRowToView),
    initialHasEarlier: page.hasEarlier,
    // The repository returns oldest-first; the files panel reads newest-first.
    initialFiles: fileRows.map((row) => mapConversationFileRowToView(row, nameById)).reverse(),
    realtimeEnabled: isRealtimeConfigured(),
  };
}

/**
 * Tallies `items` by the meeting id `meetingIdOf` derives from each one, skipping any item with
 * no meeting id. Shared by the action-item and file counters below — both were the same loop
 * over a different array and field, inlining both kept `loadCase` over SonarCloud's
 * cognitive-complexity ceiling.
 */
function countByMeetingId<T>(
  items: readonly T[],
  meetingIdOf: (item: T) => string | null
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const meetingId = meetingIdOf(item);
    if (meetingId === null) continue;
    counts.set(meetingId, (counts.get(meetingId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Load the whole case surface, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — missing, soft-deleted, cross-tenant, no-capability,
 * no-expert-profile, no-thread AND not-a-case. The caller answers ONE `notFound()` with one
 * copy, so the page never confirms a case exists to somebody who may not read it.
 */
export const loadCase = cache(
  async (
    engagementId: string,
    userId: string,
    now: Date = new Date()
  ): Promise<CaseSurfaceView | null> => {
    // 1. AUTHORIZATION. Nothing below runs until this returns non-null.
    const access = await resolveCaseAccess(engagementId, userId);
    if (access === null) {
      return null;
    }

    // 2. COHERENCE, AFTER AUTHORIZATION (BAL-129). A project engagement id and a cross-tenant
    //    id produce the SAME refusal, so this can never act as an existence oracle.
    const caseRow = await caseEngagementsRepository.findByEngagementId(engagementId);
    if (caseRow === undefined) {
      return null;
    }

    // 3. ⚠ ONLY NOW MAY `engagementId` BE PASSED TO `listMeetingsForContext` — or to any
    //    conversation read. Both seams are FK-less and RLS-less; steps 1 and 2 are the only
    //    things standing between this line and another tenant's rows.
    const { lens, companyId, expertProfileId, conversationId } = access;

    const [
      meetings,
      actionItems,
      company,
      profile,
      messagePage,
      conversationFileRows,
      earningsAggregate,
      viewer,
    ] = await Promise.all([
      meetingContextsRepository.listMeetingsForContext('case', engagementId),
      actionItemsRepository.listByEngagement(engagementId),
      companiesRepository.findNameById(companyId),
      expertsRepository.findDisplayProfileById(expertProfileId),
      conversationsRepository.listMessagesPage({
        conversationId,
        // ⚠ STATED, NEVER DEFAULTED. Both parties read the whole thread; the narrowed
        // `{ kind: 'meeting' }` scope belongs to a meeting-level guest, and a repository
        // default would put that filter one forgotten argument from a disclosure.
        scope: { kind: 'full' },
        limit: MESSAGE_PAGE_SIZE,
      }),
      conversationsRepository.listFiles(conversationId, { kind: 'full' }),
      // ⚠ EXPERT LENS ONLY. A client-lens view has no `earnings` FIELD to put it in, so the
      // read is not merely unused on that arm — it is unrepresentable.
      lens === 'expert'
        ? creditSessionsRepository.sumExpertEarningsForEngagement(engagementId)
        : Promise.resolve(null),
      usersRepository.findDisplayById(userId),
    ]);

    const clientCompanyName = company?.name ?? 'the client';

    // Ordinals drive both the consultation rows and the file card's "Consultation 3" labels.
    // ⚠ NARROWED HERE: `dailyRoomName` and `joinUrl` never reach the derivation.
    const ordinalInputs = meetings.map((meeting) => ({
      id: meeting.id,
      scheduledStart: meeting.scheduledStart,
      startedAt: meeting.startedAt,
      status: meeting.status,
      outcome: meeting.outcome,
    }));
    const meetingRefs: CaseFileMeetingRef[] = meetings.map((meeting) => ({
      meetingId: meeting.id,
      ordinal: deriveConsultationOrdinal(ordinalInputs, meeting.id).ordinal,
      occurredAt: meeting.startedAt ?? meeting.scheduledStart,
    }));

    const [labels, fileResult, transcriptMeetingIds, liveProposals] = await Promise.all([
      resolveCounterparty(lens, profile, clientCompanyName),
      loadCaseFiles({ meetings: meetingRefs, conversationId, viewerUserId: userId }),
      readTranscriptMeetingIds(meetings),
      // BAL-411 — needs `meetings`' ids, so it rides the SECOND wave, not the first.
      rescheduleProposalsRepository.findLivePendingByMeetingIds(
        meetings.map((meeting) => meeting.id)
      ),
    ]);

    // ⚠ LIVENESS (expiry) IS DECIDED HERE, ONCE, via `rescheduleProposalIsLive` — the read
    // itself filters `status = 'pending'` only (never soft-deleted), never expiry. Both the
    // consultation-row state and the header nudge below derive from THIS set, so they cannot
    // disagree about what "live" means.
    const meetingIdsWithLiveProposal = new Set(
      liveProposals
        .filter((proposal) => rescheduleProposalIsLive(proposal, now))
        .map((proposal) => proposal.meetingId)
    );

    /**
     * BAL-573 — each meeting's derived state, computed ONCE and reused by both case-level terms
     * below. `deriveCaseConsultationState` is pure; the old `.some()` here re-derived it per
     * predicate, and a second predicate would have made that three passes.
     */
    const derivedStates = meetings.map((meeting) => ({
      meetingId: meeting.id,
      status: meeting.status,
      state: deriveCaseConsultationState({
        status: meeting.status,
        outcome: meeting.outcome,
        hasLiveRescheduleProposal: meetingIdsWithLiveProposal.has(meeting.id),
      }),
    }));

    /**
     * ⚠ THE INVITE CONDITION, AND IT IS NOT THE CANCEL CONDITION. The api accepts an invite on
     * any meeting whose status is not `ended`/`cancelled` (`MEETING_CLOSED_TO_GUESTS`,
     * `guest-participation.ts:91`), and over the states a case row can hold
     * `caseConsultationIsUpcoming` is exactly that set's complement. Reusing
     * `someUpcomingMeetingIsCancellable` here would withhold Invite on a live call, which the
     * server permits.
     */
    const someUpcomingMeetingIsInvitable = derivedStates.some((row) =>
      caseConsultationIsUpcoming(row.state)
    );
    /**
     * `resolveCancelRefusal` / `CANCELLABLE_MEETING_STATUSES` from `@balo/shared/meetings` —
     * the one definition, shared with the route guard and the repository CAS, so a new status
     * is denied in all three places at once.
     *
     * `RESCHEDULABLE_MEETING_STATUSES` is the identical tuple (only the wall-clock term
     * differs), so this one boolean short-circuits both the cancel and move capability calls
     * below.
     */
    const someUpcomingMeetingIsCancellable = derivedStates.some(
      (row) => caseConsultationIsUpcoming(row.state) && resolveCancelRefusal(row.status) === null
    );

    /**
     * BAL-573 — ONE read for the whole case, upcoming rows only. ⚠ A COUNT, NEVER A ROSTER: no
     * email, no name and no token is read (ADR-1044). Skipped entirely on a case with nothing
     * upcoming, which is most closed cases.
     */
    const invitableMeetingIds = derivedStates
      .filter((row) => caseConsultationIsUpcoming(row.state))
      .map((row) => row.meetingId);
    const [guestCountRows, caseScopeDomains] = await Promise.all([
      invitableMeetingIds.length === 0
        ? Promise.resolve<Array<{ meetingId: string; count: number }>>([])
        : meetingGuestsRepository.countsLiveByMeetingIds(invitableMeetingIds),
      /**
       * BAL-573 / D3 — the owning company's LIVE registered domains, projected to bare strings
       * at the boundary. ⚠ CLIENT LENS ONLY, and that is the server's own rule, not a
       * convenience: `resolveGuestAccessScope` step (2) requires `party === 'client'`, so on the
       * expert lens there is nothing a domain match could widen and the composer must not
       * estimate otherwise. It is the VIEWER'S OWN company's domains, never the counterparty's.
       * ⚠ GATED ON THE SAME `invitableMeetingIds` TERM AS THE GUEST COUNT ABOVE — a case with
       * nothing upcoming has no invite affordance for a domain list to serve, so this must not
       * run on a closed case or one with only past consultations either.
       * ⚠ A RENDER HINT, NEVER AN AUTHORIZATION INPUT — the authoritative `access_scope` is
       * computed and STORED by `inviteGuests` at invite time (ADR-1038); this only decides which
       * sentence renders.
       */
      lens === 'client' && invitableMeetingIds.length > 0
        ? partyDomainsRepository
            .listByParty('company', companyId)
            .then((rows) => rows.map((row) => row.domain))
        : Promise.resolve<string[]>([]),
    ]);
    const guestCountByMeetingId = new Map(guestCountRows.map((row) => [row.meetingId, row.count]));

    const actionItemCountByMeetingId = countByMeetingId(actionItems, (item) => item.meetingId);

    const fileCountByMeetingId = countByMeetingId(fileResult.files, (file) =>
      file.origin === 'meeting' ? file.meetingId : null
    );

    const isOpen = caseRow.closedAt === null;
    const nextScheduled = selectNextScheduled(meetings, meetingIdsWithLiveProposal);
    // BAL-411 — the nudge cares about the proposal on THE NEXT meeting only: a live proposal's
    // meeting is always `caseConsultationIsUpcoming`, so if `nextScheduled` exists and carries a
    // proposal, this finds it; a proposal on some OTHER, later meeting is represented on that
    // meeting's own consultation row (`pending_reschedule`) but does not compete for the header.
    // The actual DETAIL (options + when it was made) is fetched only when a live proposal is
    // actually rendering in the nudge. `findLivePendingByMeetingIds` (above) is a PROJECTION
    // with no options, by design (`rescheduleProposalsRepository`'s own docblock);
    // `RescheduleProposalCard` needs real `optionId`s to accept one, so this is the one extra
    // read that gets them, and it is never speculative — most cases have no live proposal.
    const { proposal: rescheduleProposalForNudge, detail: proposalDetailForNudge } =
      await resolveRescheduleProposalForNudge(nextScheduled, liveProposals, now);

    // Item 12 — a proposal that resolved (answered/withdrawn/soft-deleted) in the gap between
    // the PROJECTION read above and this DETAIL read is treated as GONE, never rendered
    // proposal-shaped with zero options and a fabricated `proposedAtIso`. Re-deriving `nudge`
    // with `rescheduleProposal: null` here — rather than deciding it once, earlier, off the
    // projection alone — lets `selectCaseNudge` fall back to whatever it would have chosen with
    // no live proposal (`upcoming`, `resolution_ask`, …) instead of a proposal nudge nothing
    // backs.
    const nudge = selectCaseNudge({
      lens,
      isOpen,
      nextScheduled,
      resolutionRequestedAt: caseRow.resolutionRequestedAt,
      rescheduleProposal:
        rescheduleProposalForNudge !== null && proposalDetailForNudge === null
          ? null
          : rescheduleProposalForNudge,
      now,
    });

    /**
     * The MEMBERSHIP answer for this case, resolved AT MOST ONCE and read by both client-side
     * row flags below.
     *
     * ⚠ `isOpen` sits ahead of the `await`: a CLOSED case resolves NO capability call at all
     * (the invariant `resolveExpertLensCapabilities`'s docblock states). The
     * `someUpcomingMeetingIsInvitable` term covers the other half: a case whose consultations
     * are all in the past resolves nothing either.
     *
     * ⚠ NOT GATED ON CANCELLABILITY. Invite and Cancel share the same TOKEN on different
     * CONDITIONS — the api accepts an invite on a live call it refuses to cancel — so the
     * capability is resolved once against the weaker (invite) term and the cancel term is ANDed
     * in afterwards. Cancellable implies invitable, so `mayCancelAsClient` is unchanged.
     */
    const clientParticipatesOnAnUpcomingMeeting =
      lens === 'client' &&
      isOpen &&
      someUpcomingMeetingIsInvitable &&
      (await hasCapability({ id: userId }, CAPABILITIES.PARTICIPATE, { companyId }));

    const mayCancelAsClient =
      clientParticipatesOnAnUpcomingMeeting && someUpcomingMeetingIsCancellable;
    const mayInviteAsClient = clientParticipatesOnAnUpcomingMeeting;

    // Reused by both `mapCaseConsultations` and the expert return arm below; extracted to its
    // own function to keep `loadCase` under SonarCloud's cognitive-complexity ceiling.
    const expertCapabilities = await resolveExpertCapabilitiesIfNeeded(lens, {
      userId,
      engagementId,
      isOpen,
      resolutionRequestedAt: caseRow.resolutionRequestedAt,
      nextScheduledIsCancellable: someUpcomingMeetingIsCancellable,
      someUpcomingMeetingIsInvitable,
    });

    const consultations = mapCaseConsultations(
      meetings,
      {
        actionItemCountByMeetingId,
        fileCountByMeetingId,
        meetingIdsWithTranscript: transcriptMeetingIds,
        meetingIdsWithLiveProposal,
        guestCountByMeetingId,
      },
      now,
      {
        lens,
        ...resolveRowActionCapabilities(
          lens,
          { mayCancel: mayCancelAsClient, mayInvite: mayInviteAsClient },
          expertCapabilities
        ),
      }
    );

    // BAL-567 — WHO acted, for the four attributed nudge arms. One batched name read, name
    // columns only; `null` (and no read at all) for the arms nobody acted on.
    const actorLabel = await resolveNudgeActorLabel({
      actorUserId: nudgeActorUserId(nudge, caseRow, rescheduleProposalForNudge),
      lens,
      viewerUserId: userId,
      deliveringExpertUserId: profile?.userId ?? null,
      agencyName: labels.agencyLabel,
      partyFallbackLabel: labels.expertPartyShort,
    });

    // `nudgeReuse` avoids a second `findNamesByIds` round trip when the live proposal is on
    // `nextScheduled` — the nudge above already resolved that actor's name. `ordinalByMeetingId`
    // looks up the ordinal from the consultation rows already built above, rather than a second
    // `deriveConsultationOrdinal` pass.
    const ordinalByMeetingId = new Map(consultations.map((row) => [row.meetingId, row.ordinal]));

    const rescheduleProposals = await resolveRescheduleProposalViews(
      meetings,
      liveProposals,
      meetingIdsWithLiveProposal,
      lens,
      {
        viewerUserId: userId,
        deliveringExpertUserId: profile?.userId ?? null,
        agencyName: labels.agencyLabel,
        partyFallbackLabel: labels.expertPartyShort,
        ordinalByMeetingId,
        nudgeReuse:
          rescheduleProposalForNudge !== null && proposalDetailForNudge !== null
            ? {
                proposalId: rescheduleProposalForNudge.proposalId,
                actorLabel,
                detail: proposalDetailForNudge,
              }
            : null,
      }
    );

    const header: CaseHeaderView = {
      title: caseRow.title,
      // ⚠ SANITISED HERE, AT READ, AND THAT IS LOAD-BEARING — NOT belt-and-braces.
      // `case_engagements.description` has NO enforced write-side sanitisation: the schema
      // (`schema/case-engagements.ts:60-72`) says the FIRST writer must sanitise, and today
      // every writer is a hardcoded literal (seed + test factories), so no such code exists
      // yet. `CaseHeader` is a client component and structurally cannot sanitise, so this
      // server-side pass is the only guard standing between a future client-supplied
      // description (BAL-400 booking) and stored XSS. Mirrors the defensive re-sanitise at
      // `components/balo/project-request/rich-text.tsx:28`. Do NOT remove it on the grounds
      // that the writer "should" sanitise — re-sanitising is idempotent and cheap.
      descriptionHtml: sanitizeProjectHtml(caseRow.description),
      openedAtIso: caseRow.createdAt.toISOString(),
      heldConsultationCount: consultations.filter((row) => row.state === 'held').length,
      consultationCount: consultations.length,
      isOpen,
      closeReason: caseRow.closeReason,
      closedAtIso: caseRow.closedAt?.toISOString() ?? null,
      counterpartyOrgLabel: labels.counterpartyOrgLabel,
      closedNote: resolveClosedNote(caseRow),
    };

    const viewerName = personDisplayName(
      viewer?.firstName ?? null,
      viewer?.lastName ?? null,
      'You'
    );
    const people: CasePersonView[] = [
      { name: viewerName, isViewer: true },
      { name: labels.counterpartyName, isViewer: false },
    ];

    const base = {
      counterpartyPartyLabel: labels.counterpartyPartyLabel,
      /**
       * BAL-573 — the CLIENT company's name, for the invite composer's scope disclosure.
       * `null` when unresolvable. Present on both lenses: the expert already reads it as the
       * counterparty org. ⚠ `null`, NEVER the 'the client' placeholder — that is a phrase, and
       * the composer needs a NAME or null.
       */
      clientCompanyName: company?.name ?? null,
      engagementId,
      expertProfileId,
      viewerUserId: userId,
      header,
      nudge: toNudgeView(nudge, nextScheduled, actorLabel, now),
      consultations,
      rescheduleProposals,
      conversation: await buildConversation(access, labels, messagePage, conversationFileRows),
      actionItems: buildActionItems(
        actionItems,
        lens,
        clientCompanyName,
        labels.expertPartyShort,
        labels.counterpartyFirstName,
        now.getTime()
      ),
      files: fileResult.files,
      filesTruncated: fileResult.truncated,
      party: labels.party,
      people,
    };

    // ⚠⚠ THE LENS IS A DISCRIMINANT. The client arm is CONSTRUCTED WITHOUT an `earnings`
    // field, so there is no optional property for a bug to populate — a client-lens view
    // object cannot HOLD an expert's earnings figure. The expert arm has no `canClose`,
    // because only a client may close a case (BAL-417); the expert may only ASK.
    if (lens === 'expert') {
      // Never null here — resolved above under the same `lens === 'expert'` guard. The
      // fallback covers a TS narrowing gap across the intervening `await`s, not a real arm.
      const capabilities = expertCapabilities ?? EMPTY_EXPERT_CAPABILITIES;
      return {
        ...base,
        lens: 'expert',
        earnings: toEarningsView(earningsAggregate ?? EMPTY_EARNINGS),
        canRequestResolution: capabilities.mayRequestResolution,
        canManageReschedule: capabilities.canManageReschedule,
      };
    }
    return { ...base, lens: 'client', canClose: isOpen, caseScopeDomains };
  }
);

interface ExpertLensCapabilitiesInput {
  userId: string;
  engagementId: string;
  isOpen: boolean;
  resolutionRequestedAt: Date | null;
  /** True when at least one upcoming meeting is cancellable — not only the next one. */
  nextScheduledIsCancellable: boolean;
  /** BAL-573 — true when at least one upcoming meeting is invitable (the api's own gate is a
   *  status DENY-set, not cancellability — see `mayInviteAsExpert`'s own comment below). */
  someUpcomingMeetingIsInvitable: boolean;
}

interface ExpertLensCapabilities {
  mayRequestResolution: boolean;
  canManageReschedule: boolean;
  mayCancelAsExpert: boolean;
  /** BAL-573 — the SAME `manage_engagement` token as `canManageReschedule`, ANDed with the
   *  invite condition instead of the cancel one. See `managesEngagementWhileOpen`'s comment. */
  mayInviteAsExpert: boolean;
}

/**
 * The three independent, short-circuiting `manage_engagement` capability checks gated on the
 * expert lens — extracted from `loadCase` to keep it under SonarCloud's cognitive-complexity
 * ceiling of 15. Behaviour is UNCHANGED by the extraction; every reasoning comment below is
 * copied verbatim from the call site it used to sit at.
 *
 * ⚠⚠ THE CAPABILITY TERM IS REQUIRED ON EVERY FLAG — VISIBILITY IS DELIBERATELY WIDER THAN THE
 * ACT. `resolveCaseAccess` admits ANY live agency member, INCLUDING agency role `expert`
 * (`actorHasExpertSideVisibility`, BAL-419 — deliberately wide, never narrow it), who is NOT a
 * `manage_engagement` holder (ADR-1046 §7) and would otherwise get a dead-end button — the one
 * kind of CTA this surface's own rule forbids ("an absent action beats a dead one",
 * `case-view-types.ts`). The read is resolved here so the server action stays the authority and
 * this stays a render hint: it is NOT trusted by the action, which re-checks independently.
 *
 * ⚠ EACH FLAG SHORT-CIRCUITS ITS OWN `await hasEngagementCapability(...)` INDEPENDENTLY — NOT a
 * shared/hoisted call. A shared call was tried and reverted: it made the capability check
 * unconditional on `isOpen` alone, which broke the pre-existing invariant (pinned by its own
 * test) that a CLOSED case resolves no capability call at all. Three calls with identical
 * short-circuit shape cost nothing extra in the common case — at most one of the three ever
 * actually awaits, because at most one of `canRequestResolution`/`canManageReschedule`/
 * `mayCancelAsExpert` is relevant to any one case state.
 */
async function resolveExpertLensCapabilities(
  input: ExpertLensCapabilitiesInput
): Promise<ExpertLensCapabilities> {
  const {
    userId,
    engagementId,
    isOpen,
    resolutionRequestedAt,
    nextScheduledIsCancellable,
    someUpcomingMeetingIsInvitable,
  } = input;
  const contextSubject = { contextType: 'case' as const, contextId: engagementId };

  const mayRequestResolution =
    isOpen &&
    resolutionRequestedAt === null &&
    (await hasEngagementCapability(
      { id: userId },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      contextSubject
    ));
  // Item 18 (security LOW) — the WITHDRAW holder set: the SAME `manage_engagement` check as
  // the per-row `canProposeReschedule`, without its "no live proposal already outstanding"
  // condition — that per-row flag is structurally FALSE exactly when Withdraw would be
  // relevant (a live proposal already exists), so it cannot be reused as-is to gate the
  // Withdraw button; this gives the card the actual holder set instead of `lens === 'expert'`
  // alone (which also admits an agency member with role `expert` — a legitimate viewer of the
  // case surface who is deliberately and permanently NOT a `manage_engagement` holder,
  // ADR-1046 §7).
  /**
   * `manage_engagement` on an OPEN case — the answer BOTH the reschedule-management flag and
   * the per-row invite flag are built from, resolved with ONE `await` because their predicates
   * are identical up to the invite flag's extra term.
   *
   * ⚠ `isOpen &&` sits ahead of this `await`, and the other two flags below keep their own
   * independent short-circuits, so a CLOSED case resolves no capability call here either — the
   * engagement-axis read COUNT is 3 on an open cancellable case, 2 once the meeting has
   * started.
   * ⚠ IF THE TWO PREDICATES EVER DIVERGE, SPLIT THE `await` — do not add a term to one name.
   */
  const managesEngagementWhileOpen =
    isOpen &&
    (await hasEngagementCapability(
      { id: userId },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      contextSubject
    ));
  // Item 18's holder set, unchanged.
  const canManageReschedule = managesEngagementWhileOpen;
  // BAL-573 — the SAME token, the SAME `isOpen` gate, a DIFFERENT row condition (see D2).
  const mayInviteAsExpert = managesEngagementWhileOpen && someUpcomingMeetingIsInvitable;
  // BAL-410 — the THIRD independent short-circuiting call, on the SAME pattern and for the
  // same reason the docblock above gives: at most one of the three ever actually awaits for
  // any given case state, and hoisting them would break the pinned invariant that a CLOSED
  // case resolves no capability call at all. Also gates `mapCaseConsultations`'s per-row flags
  // on the expert lens (the caller reuses this result).
  const mayCancelAsExpert =
    isOpen &&
    nextScheduledIsCancellable &&
    (await hasEngagementCapability(
      { id: userId },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      contextSubject
    ));

  return { mayRequestResolution, canManageReschedule, mayCancelAsExpert, mayInviteAsExpert };
}

async function resolveExpertCapabilitiesIfNeeded(
  lens: 'client' | 'expert',
  input: ExpertLensCapabilitiesInput
): Promise<ExpertLensCapabilities | null> {
  if (lens !== 'expert') return null;
  return resolveExpertLensCapabilities(input);
}

/** The case-level capabilities `mapCaseConsultations` ANDs into every row's flags. */
function resolveRowActionCapabilities(
  lens: 'client' | 'expert',
  client: { mayCancel: boolean; mayInvite: boolean },
  expertCapabilities: ExpertLensCapabilities | null
): { mayAct: boolean; mayInvite: boolean } {
  if (lens === 'client') return { mayAct: client.mayCancel, mayInvite: client.mayInvite };
  return {
    mayAct: expertCapabilities?.mayCancelAsExpert ?? false,
    mayInvite: expertCapabilities?.mayInviteAsExpert ?? false,
  };
}

/**
 * The `not_yet` aggregate, for the unreachable case where the expert-lens read resolved to
 * `null`. Named rather than inlined so the fallback is visibly the EMPTY state and never a
 * fabricated zero figure.
 */
const EMPTY_EARNINGS: CaseExpertEarningsAggregate = {
  state: 'not_yet',
  finalizedSessionCount: 0,
  pendingSessionCount: 0,
  earningsAudMinor: null,
};

/** The all-`false` fallback for the unreachable branch where `expertCapabilities` is read
 *  outside the `lens === 'expert'` guard — visibly the empty state, never a fabricated grant. */
const EMPTY_EXPERT_CAPABILITIES: ExpertLensCapabilities = {
  mayRequestResolution: false,
  canManageReschedule: false,
  mayCancelAsExpert: false,
  mayInviteAsExpert: false,
};

/**
 * Decoupled from `nudge` — a proposal on another meeting still gets a card, not just the
 * nudge's own.
 *
 * Gates on `caseConsultationIsUpcoming` explicitly: `findLivePendingByMeetingIds` has no
 * meeting-status term, so without this a proposal on an already-cancelled meeting would still
 * render a live card.
 *
 * Loops rather than batches the detail read: at most one pending proposal per meeting (a
 * partial unique index) and a handful of upcoming meetings per case, so this never becomes a
 * real N+1.
 */
async function resolveRescheduleProposalViews(
  meetings: readonly Meeting[],
  liveProposals: readonly LiveRescheduleProposalSummary[],
  meetingIdsWithLiveProposal: ReadonlySet<string>,
  lens: 'client' | 'expert',
  input: {
    viewerUserId: string;
    deliveringExpertUserId: string | null;
    agencyName: string | null;
    partyFallbackLabel: string;
    /** Per-meeting ordinal for the subject line — see the call site for why this is a lookup,
     *  not a second derivation. */
    ordinalByMeetingId: ReadonlyMap<string, number | null>;
    /** The nudge's own proposal — reused verbatim for the matching row rather than a second
     *  `findPendingForAnswer` + `findNamesByIds` round trip when the live proposal is on
     *  `nextScheduled`. `null` when the nudge isn't a proposal arm. */
    nudgeReuse: {
      proposalId: string;
      actorLabel: string;
      detail: RescheduleProposalDetailForNudge;
    } | null;
  }
): Promise<CaseRescheduleProposalView[]> {
  const upcomingMeetingIdsWithLiveProposal = new Set(
    meetings
      .filter((meeting) => {
        if (!meetingIdsWithLiveProposal.has(meeting.id)) return false;
        const state = deriveCaseConsultationState({
          status: meeting.status,
          outcome: meeting.outcome,
          hasLiveRescheduleProposal: true,
        });
        return caseConsultationIsUpcoming(state);
      })
      .map((meeting) => meeting.id)
  );
  if (upcomingMeetingIdsWithLiveProposal.size === 0) {
    return [];
  }

  const summaries = liveProposals.filter((proposal) =>
    upcomingMeetingIdsWithLiveProposal.has(proposal.meetingId)
  );

  // `scheduled_end − scheduled_start`, the same formula `mapCaseConsultations` uses for
  // `scheduledMinutes` — a reschedule moves this meeting, it never resizes it, so every option
  // below renders against the CURRENT booked length, never each option's own (nonexistent) one.
  const durationByMeetingId = new Map(
    meetings.map((meeting) => [
      meeting.id,
      Math.round((meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime()) / 60_000),
    ])
  );

  // Only proposals other than the nudge's own need a detail read and a name lookup.
  const toResolve = summaries.filter(
    (summary) => summary.proposalId !== input.nudgeReuse?.proposalId
  );

  const resolved = await Promise.all(
    toResolve.map(async (summary) => ({
      summary,
      found: await rescheduleProposalsRepository.findPendingForAnswer({
        proposalId: summary.proposalId,
        meetingId: summary.meetingId,
      }),
    }))
  );

  const idsToQuery = [...new Set(toResolve.map((summary) => summary.proposedByUserId))];
  const actors = idsToQuery.length === 0 ? [] : await usersRepository.findNamesByIds(idsToQuery);
  const firstNameById = new Map(actors.map((actor) => [actor.id, actor.firstName ?? null]));

  const views: CaseRescheduleProposalView[] = [];

  if (input.nudgeReuse !== null) {
    const nudgeSummary = summaries.find(
      (summary) => summary.proposalId === input.nudgeReuse?.proposalId
    );
    if (nudgeSummary !== undefined) {
      views.push(
        toRescheduleProposalView(
          nudgeSummary,
          input.nudgeReuse.detail,
          input.nudgeReuse.actorLabel,
          input.ordinalByMeetingId.get(nudgeSummary.meetingId) ?? null,
          durationByMeetingId.get(nudgeSummary.meetingId) ?? 0
        )
      );
    }
  }

  for (const { summary, found } of resolved) {
    // A detail read racing the proposal resolving out from under it is treated as GONE, not
    // rendered with fabricated options.
    if (found === undefined) continue;
    const actorLabel = resolveActorLabel({
      side: lens,
      actorUserId: summary.proposedByUserId,
      actorFirstName: firstNameById.get(summary.proposedByUserId) ?? null,
      viewerUserId: input.viewerUserId,
      deliveringExpertUserId: input.deliveringExpertUserId ?? '',
      agencyName: input.agencyName,
      partyFallbackLabel: input.partyFallbackLabel,
    });
    views.push(
      toRescheduleProposalView(
        summary,
        { createdAt: found.proposal.createdAt, options: found.options },
        actorLabel,
        input.ordinalByMeetingId.get(summary.meetingId) ?? null,
        durationByMeetingId.get(summary.meetingId) ?? 0
      )
    );
  }
  return views;
}

function toRescheduleProposalView(
  summary: LiveRescheduleProposalSummary,
  detail: RescheduleProposalDetailForNudge,
  actorLabel: string,
  ordinal: number | null,
  durationMinutes: number
): CaseRescheduleProposalView {
  return {
    proposalId: summary.proposalId,
    meetingId: summary.meetingId,
    ordinal,
    optionCount: summary.optionCount,
    originalScheduledStartIso: summary.originalScheduledStart.toISOString(),
    expiresAtIso: summary.expiresAt.toISOString(),
    proposedAtIso: detail.createdAt.toISOString(),
    durationMinutes,
    options: detail.options.map((option) => ({
      optionId: option.id,
      scheduledStartIso: option.scheduledStart.toISOString(),
    })),
    actorLabel,
  };
}

/**
 * The soonest consultation still expected to happen — what the `upcoming` nudge names. It has
 * exactly ONE caller (`selectCaseNudge`); the colleague-invite anchor that used to be its
 * second reader is BAL-408's, not this surface's, and is not built here.
 *
 * ⚠ `in_progress` COUNTS, AND IT MUST. A call happening RIGHT NOW is the single most urgent
 * thing the header can say; excluding it would show "Nothing booked yet" to two people who are
 * mid-consultation. Its `scheduledStart` is in the past, so the join window is satisfied and
 * the nudge renders live — which is exactly right.
 */
function selectNextScheduled(
  meetings: readonly Meeting[],
  meetingIdsWithLiveProposal: ReadonlySet<string>
): {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: Meeting['status'];
} | null {
  const upcoming = meetings
    .filter((meeting) => {
      const state = deriveCaseConsultationState({
        status: meeting.status,
        outcome: meeting.outcome,
        hasLiveRescheduleProposal: meetingIdsWithLiveProposal.has(meeting.id),
      });
      // BAL-411 — `caseConsultationIsUpcoming`, NOT a hand-rolled `'scheduled' | 'in_progress'`
      // check: it ALSO admits `pending_reschedule`, so a meeting carrying a live proposal is
      // not dropped from the case surface's next-consultation entirely while the ask is open.
      return caseConsultationIsUpcoming(state);
    })
    .sort((a, b) => {
      // Lead with the POSITIVE branch (S7735 / unicorn/no-negated-condition). Behaviour is
      // identical: same start time ⇒ break the tie on id, otherwise order by start time.
      const delta = a.scheduledStart.getTime() - b.scheduledStart.getTime();
      return delta === 0 ? a.id.localeCompare(b.id) : delta;
    });

  const [next] = upcoming;
  if (next === undefined) return null;
  // BAL-409 — `scheduledEnd` rides alongside for the reschedule dialog's duration pin
  // (`toNudgeView`). `selectCaseNudge`'s own `nextScheduled` parameter type only reads
  // `meetingId`/`scheduledStart`; the extra fields are structurally ignored there.
  //
  // ⚠ BAL-410 — `status` RIDES ALONGSIDE TOO, and it is NOT decoration. This selector admits
  // `waiting_for_participants` and `in_progress` (both fold into the `'scheduled'` consultation
  // STATE, and `in_progress` must count — see the docblock above), but neither is CANCELLABLE.
  // The cancel render hints gate on it through `resolveCancelRefusal`.
  return {
    meetingId: next.id,
    scheduledStart: next.scheduledStart,
    scheduledEnd: next.scheduledEnd,
    status: next.status,
  };
}

/**
 * Which of this case's consultations have a transcript.
 *
 * ⚠⚠ ONE QUERY FOR THE WHOLE CASE, NOT ONE PER CONSULTATION. Restricting to `ended` narrows
 * the id list but is NOT a bound: a long-running case is exactly the one with many ended
 * consultations, so a per-meeting read scaled linearly with the page's own content — forty
 * held consultations meant forty queries on every render. `findByMeetingIds` answers for all
 * of them in a single round trip, still projected to `id` + `status` so the `canonical` jsonb
 * (the whole raw segment array) is never pulled.
 *
 * ⚠ NEVER THROWS. A transcript indicator is decoration on a page whose job is to say what
 * happened; a failed read degrades to "no indicator", never to a failed render. The batched
 * read makes that degradation all-or-nothing rather than per-row, which is the honest
 * trade — the indicator is absent, and absence already means "no transcript" here.
 */
async function readTranscriptMeetingIds(
  meetings: readonly Meeting[]
): Promise<ReadonlySet<string>> {
  const endedIds = meetings
    .filter((meeting) => meeting.status === 'ended')
    .map((meeting) => meeting.id);
  if (endedIds.length === 0) return new Set();

  try {
    const byMeetingId = await transcriptsRepository.findByMeetingIds(endedIds);
    const ready = new Set<string>();
    for (const [meetingId, transcript] of byMeetingId) {
      if (transcript.status === 'ready') ready.add(meetingId);
    }
    return ready;
  } catch (error) {
    log.warn('Case surface transcript lookup failed', {
      meetingCount: endedIds.length,
      error: errorMessage(error),
    });
    return new Set();
  }
}
