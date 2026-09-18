import 'server-only';

import {
  CASES_INDEX_OPEN_PAGE_SIZE,
  CASES_INDEX_RESOLVED_PAGE_SIZE,
  casesIndexRepository,
  conversationContextKey,
  conversationsRepository,
  partyMembershipsRepository,
  rescheduleProposalsRepository,
  usersRepository,
  type CasesIndexCaseRow,
  type CasesIndexCursor,
  type CasesIndexScope,
  type ResolvedCasesCursor,
} from '@balo/db';
import { resolveCompanyParticipation } from '@balo/shared/authz';
import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { navWorkspaceTypeOf } from '@/lib/navigation/nav-context';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import {
  buildCasesIndexCards,
  buildCasesIndexResolvedRows,
  indexLiveProposals,
  resolveFeaturedEngagementId,
  type CasesIndexCardContext,
} from './build-cases-index-cards';
import type {
  CasesIndexCardView,
  CasesIndexData,
  CasesIndexEmptyKind,
  CasesIndexResolvedRowView,
  CasesIndexSide,
} from './cases-index-view-types';

/**
 * BAL-567 — the `/cases` index's SERVER loader: the authorization gate, then the batched reads.
 *
 * ⚠⚠ THE GATE IS CAPABILITY-BASED AND LIVES IN EXACTLY ONE PLACE. The company arm consumes
 * `resolveCompanyParticipation` (`@balo/shared/authz`) — the SAME one definition
 * `authorizeEngagementConversation` uses — and it is called from this file only. Nothing here
 * compares `activeMode`, a role string or a lens: which LIST to read is a workspace choice
 * (`navWorkspaceTypeOf`), and a workspace choice authorizes nothing (ADR-1029). Pinned by
 * `invariants/cases-index-no-view-gate.test.ts`.
 *
 * ⚠⚠ THE SCOPE IS ALWAYS THE SESSION'S OWN PARTY ID, NEVER A PARAM. `casesIndexRepository` makes
 * no authorization decision of its own (its module docblock says so); handing it an arbitrary
 * `companyId` would return that company's cases.
 *
 * ⚠⚠ NOTHING IS FETCHED PER CARD. Six batched reads serve a whole page, in three waves: the page
 * itself, then everything keyed by its engagement ids, then everything keyed by its meeting ids.
 * A seventh read added inside a `.map()` is the regression this structure exists to prevent.
 */

/** Which workspace's cases, resolved from the session — see the module docblock. */
export type CasesIndexRequest =
  | { readonly side: 'company'; readonly companyId: string; readonly companyName: string }
  | { readonly side: 'expert'; readonly expertProfileId: string; readonly companyName: string };

/**
 * THE SESSION → THE REQUEST. `null` means "this session has no cases list to show" — an
 * expert-workspace session with no `expertProfileId`, which the page answers with
 * `redirect('/dashboard')` (the `expert/calendar/page.tsx` precedent).
 *
 * ⚠⚠ EVERY PARTY ID COMES FROM THE SEALED SESSION, NEVER FROM AN ARGUMENT OR A URL. This is the
 * single place the two "show more" Server Actions re-derive their scope from, which is why they
 * take ONLY a cursor: a `companyId` on the wire would be a client-supplied tenancy key.
 *
 * ⚠ `navWorkspaceTypeOf` IS A WORKSPACE-SCOPING PROJECTION, NOT AN AUTHORIZATION GATE (its own
 * docblock says so). It picks WHICH list; `resolveCompanyParticipation` decides whether the
 * viewer may read it.
 *
 * ⚠ TRUTHINESS ON `expertProfileId`, matching `requireExpert()` and `dashboard/page.tsx`:
 * `SessionUser` is a type assertion over cookie JSON with NO runtime validation, so an
 * empty-string id is representable and must not be treated as a profile.
 */
export function resolveCasesIndexRequest(user: SessionUser): CasesIndexRequest | null {
  if (navWorkspaceTypeOf(user) === 'expert') {
    const { expertProfileId } = user;
    if (!expertProfileId) return null;
    return { side: 'expert', expertProfileId, companyName: user.companyName };
  }
  return { side: 'company', companyId: user.companyId, companyName: user.companyName };
}

export interface LoadCasesIndexInput {
  readonly viewerUserId: string;
  readonly request: CasesIndexRequest;
  readonly now?: Date;
}

/**
 * The COMPANY arm's gate. Two of the three outcomes deny.
 *
 * ⚠ BOTH NON-PARTICIPANT OUTCOMES RENDER THE LOCK STATE, not an empty list.
 * `authorizeEngagementConversation`'s client arm denies `member_without_participate` OUTRIGHT
 * rather than falling through, so such a viewer can open NOTHING — and an empty list would tell
 * them they have no cases, which is a different and false statement.
 *
 * ⚠ D9 — `member_without_participate` IS UNREACHABLE AS OF THIS COMMIT: the company role enum is
 * `owner`/`admin`/`member` and all three grant `PARTICIPATE`. The branch exists because the
 * loader must handle every value the resolver can return; omitting it would leave an unhandled
 * case that falls through to LISTING the cases, which is the exact failure the gate prevents.
 * It is covered by a component test that renders the state directly — an integration test would
 * be vacuous, and a fixture manufactured to reach it would prove the fixture wrong, not the gate
 * right.
 */
async function companyScopeOrDenial(
  companyId: string,
  viewerUserId: string
): Promise<CasesIndexScope | null> {
  const participation = await resolveCompanyParticipation(
    companyId,
    viewerUserId,
    // ⚠ BOTH IDS PER CALL, never a captured closure — the confused-deputy guard
    // `CompanyRoleLookup`'s own docblock requires.
    (partyId, actorId) => partyMembershipsRepository.getMemberRole('company', partyId, actorId)
  );
  if (participation === 'participant') return { side: 'company', companyId };

  log.warn('Cases index denied: viewer does not participate in the workspace company', {
    userId: viewerUserId,
    companyId,
    participation,
  });
  return null;
}

/** The scope for a request, or `null` when the viewer may not read this workspace's cases. */
export async function resolveCasesIndexScope(
  input: Pick<LoadCasesIndexInput, 'viewerUserId' | 'request'>
): Promise<CasesIndexScope | null> {
  const { request, viewerUserId } = input;
  if (request.side === 'company') {
    return companyScopeOrDenial(request.companyId, viewerUserId);
  }
  // ⚠ NO PARTICIPATION CALL ON THE EXPERT ARM, and that is not a gap. The scope IS the session's
  // own `expertProfileId`, so the question "may this viewer see this expert's deliveries?" is
  // answered by identity: an expert always participates in their own delivery list. The
  // repository's dual-membership exclusion is what keeps a case that resolves to the CLIENT side
  // out of this list.
  return { side: 'expert', expertProfileId: request.expertProfileId, viewerUserId };
}

/**
 * The engagement ids whose thread carries unread inbound activity for this viewer.
 *
 * ⚠⚠ THE UNREAD JOIN LIVES IN THE WEB LAYER, NEVER IN THE REPOSITORY — the `projects-inbox.ts`
 * layering rule. Two BATCHED reads over the whole page; `unreadSummaryFor` (the counting one)
 * fires SEVEN queries per conversation and must never be reached from a list.
 *
 * "Unread" is `latestInboundActivityAt !== null && (lastReadAt === null || inbound > lastRead)` —
 * the same definition the project inbox and the notification digest share, so the two surfaces
 * cannot disagree about whether a thread is unread.
 */
async function resolveUnreadEngagementIds(
  engagementIds: readonly string[],
  viewerUserId: string
): Promise<ReadonlySet<string>> {
  const unread = new Set<string>();
  if (engagementIds.length === 0) return unread;

  const conversationIdByKey = await conversationsRepository.conversationIdsForContexts(
    engagementIds.map((contextId) => ({ contextType: 'engagement' as const, contextId }))
  );
  const engagementIdByConversation = new Map<string, string>();
  for (const engagementId of engagementIds) {
    const conversationId = conversationIdByKey.get(
      conversationContextKey({ contextType: 'engagement', contextId: engagementId })
    );
    if (conversationId !== undefined) engagementIdByConversation.set(conversationId, engagementId);
  }
  if (engagementIdByConversation.size === 0) return unread;

  const summaries = await conversationsRepository.listThreadSummaries({
    conversationIds: [...engagementIdByConversation.keys()],
    viewerUserId,
  });
  for (const summary of summaries) {
    const engagementId = engagementIdByConversation.get(summary.conversationId);
    if (engagementId === undefined) continue;
    const { latestInboundActivityAt, lastReadAt } = summary;
    if (latestInboundActivityAt === null) continue;
    if (lastReadAt === null || latestInboundActivityAt > lastReadAt) unread.add(engagementId);
  }
  return unread;
}

/**
 * Everything a page of open cases needs to become card views — five batched reads across two
 * waves (the meeting-keyed ones cannot start until the trail has named the meetings).
 *
 * Shared by the first page and by `loadMoreOpenCases`, so a "show more" page is built by exactly
 * the same rules as page one.
 */
export async function buildCardContext(
  rows: readonly CasesIndexCaseRow[],
  input: { side: CasesIndexSide; viewerUserId: string; now: Date }
): Promise<CasesIndexCardContext> {
  const engagementIds = rows.map((row) => row.engagementId);

  const [trailByEngagement, tagsByEngagement, actionItemsByEngagement, unreadEngagementIds] =
    await Promise.all([
      casesIndexRepository.listCaseTrailMeetings(engagementIds),
      casesIndexRepository.listCaseProductTags(engagementIds),
      casesIndexRepository.countOpenActionItemsByParty(engagementIds),
      resolveUnreadEngagementIds(engagementIds, input.viewerUserId),
    ]);

  const meetingIds = [...trailByEngagement.values()].flatMap((trail) =>
    trail.map((meeting) => meeting.meetingId)
  );
  const proposals =
    meetingIds.length === 0
      ? []
      : await rescheduleProposalsRepository.findLivePendingByMeetingIds(meetingIds);
  const proposalByMeetingId = indexLiveProposals(proposals, input.now);

  // ONE batched name read over the union of both attributed actor sets. NAME COLUMNS ONLY
  // (ADR-1044) — `findNamesByIds` projects `id`/`firstName`/`lastName` and nothing else.
  const actorIds = [
    ...new Set([
      ...rows.flatMap((row) =>
        row.resolutionRequestedByUserId === null ? [] : [row.resolutionRequestedByUserId]
      ),
      ...[...proposalByMeetingId.values()].map((proposal) => proposal.proposedByUserId),
    ]),
  ];
  const actors = actorIds.length === 0 ? [] : await usersRepository.findNamesByIds(actorIds);

  return {
    side: input.side,
    viewerUserId: input.viewerUserId,
    now: input.now,
    trailByEngagement,
    tagsByEngagement,
    actionItemsByEngagement,
    unreadEngagementIds,
    proposalByMeetingId,
    actorFirstNameById: new Map(actors.map((actor) => [actor.id, actor.firstName])),
    featuredEngagementId: resolveFeaturedEngagementId(rows),
  };
}

/** The cursor a page hands back, or `null` when there is nothing after it. */
function openCursorFor(
  rows: readonly CasesIndexCaseRow[],
  hasMore: boolean
): { bucket: number; sortRank: number; id: string } | null {
  if (!hasMore) return null;
  const [last] = rows.slice(-1);
  if (last === undefined) return null;
  return { bucket: last.bucket, sortRank: last.sortRank, id: last.engagementId };
}

/**
 * Which empty state an empty list renders.
 *
 * ⚠ A FAILED CHECKLIST READ COUNTS AS INCOMPLETE — the same rule
 * `resolveExpertUpNextSurface` applies. An expert with no cases and an unknown setup state is
 * better served by "finish setup" than by a bare "no cases yet" that suggests nothing to do.
 *
 * ⚠ ONLY `allComplete` IS READ FROM THE CHECKLIST, AND NOTHING ELSE MAY BE. `ChecklistStatus`
 * carries `rateCents` — MONEY — and this page's view model has nowhere to put it and no business
 * knowing it.
 */
async function resolveEmptyKind(
  side: CasesIndexSide,
  isEmpty: boolean,
  viewerUserId: string
): Promise<CasesIndexEmptyKind | null> {
  if (!isEmpty) return null;
  if (side === 'company') return 'no_cases';
  try {
    const checklist = await getChecklistStatus();
    return checklist.allComplete ? 'no_cases' : 'expert_setup_incomplete';
  } catch (error) {
    log.warn('Cases index could not read the expert checklist; assuming setup is incomplete', {
      userId: viewerUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'expert_setup_incomplete';
  }
}

/** The first page of `/cases`, or the lock state. Throws on a read failure — see `read-cases-index-data.ts`. */
export async function loadCasesIndex(input: LoadCasesIndexInput): Promise<CasesIndexData> {
  const now = input.now ?? new Date();
  const scope = await resolveCasesIndexScope(input);
  if (scope === null) {
    return { kind: 'no_access', companyName: input.request.companyName };
  }

  const [openPage, counts] = await Promise.all([
    casesIndexRepository.listOpenCases(scope, { limit: CASES_INDEX_OPEN_PAGE_SIZE }),
    casesIndexRepository.countCasesForScope(scope),
  ]);

  const side = input.request.side;
  const context = await buildCardContext(openPage.rows, {
    side,
    viewerUserId: input.viewerUserId,
    now,
  });
  const cards = buildCasesIndexCards(openPage.rows, context);
  // The FEATURED case is row 1 of page 1 and only when it has a booking — the repository's
  // ordering makes that structural, so this is a split rather than a search.
  const featured = context.featuredEngagementId === null ? null : (cards[0] ?? null);
  const open = featured === null ? cards : cards.slice(1);

  return {
    kind: 'ready',
    side,
    companyName: input.request.companyName,
    featured,
    open,
    openHasMore: openPage.hasMore,
    openCursor: openCursorFor(openPage.rows, openPage.hasMore),
    openCount: counts.open,
    resolvedCount: counts.resolved,
    empty: await resolveEmptyKind(
      side,
      counts.open === 0 && counts.resolved === 0,
      input.viewerUserId
    ),
  };
}

/** One page of OPEN cases after the first — the "show more" read, built by the same rules. */
export async function loadMoreOpenCasesPage(input: {
  viewerUserId: string;
  request: CasesIndexRequest;
  after: CasesIndexCursor;
  now?: Date;
}): Promise<{
  rows: readonly CasesIndexCardView[];
  hasMore: boolean;
  nextCursor: { bucket: number; sortRank: number; id: string } | null;
} | null> {
  const now = input.now ?? new Date();
  const scope = await resolveCasesIndexScope(input);
  if (scope === null) return null;

  const page = await casesIndexRepository.listOpenCases(scope, {
    limit: CASES_INDEX_OPEN_PAGE_SIZE,
    after: input.after,
  });
  const context = await buildCardContext(page.rows, {
    side: input.request.side,
    viewerUserId: input.viewerUserId,
    now,
  });
  return {
    // ⚠ NO FEATURED CARD ON A LATER PAGE, so `featuredEngagementId` is nulled: the ticket card is
    // page one's first row, and a second Join button further down the list would be a second
    // "next consultation".
    rows: buildCasesIndexCards(page.rows, { ...context, featuredEngagementId: null }),
    hasMore: page.hasMore,
    nextCursor: openCursorFor(page.rows, page.hasMore),
  };
}

/**
 * One page of RESOLVED cases — loaded LAZILY, on the first expansion of the collapsed section.
 *
 * ⚠ NO TRAIL, NO UNREAD, NO TAGS. A resolved case has nothing left to act on, so the extra reads
 * would be work nobody can use.
 */
export async function loadResolvedCasesPage(input: {
  viewerUserId: string;
  request: CasesIndexRequest;
  after?: ResolvedCasesCursor;
}): Promise<{
  rows: readonly CasesIndexResolvedRowView[];
  hasMore: boolean;
  nextCursor: { closedAtEpoch: number; id: string } | null;
} | null> {
  const scope = await resolveCasesIndexScope(input);
  if (scope === null) return null;

  const page = await casesIndexRepository.listResolvedCases(scope, {
    limit: CASES_INDEX_RESOLVED_PAGE_SIZE,
    after: input.after,
  });
  const [last] = page.rows.slice(-1);
  return {
    rows: buildCasesIndexResolvedRows(page.rows, input.request.side),
    hasMore: page.hasMore,
    nextCursor:
      page.hasMore && last !== undefined
        ? { closedAtEpoch: last.closedAtEpoch, id: last.engagementId }
        : null,
  };
}
