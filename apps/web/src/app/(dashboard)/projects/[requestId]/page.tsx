import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  projectRequestsRepository,
  companyBillingRepository,
  projectEngagementsRepository,
  usersRepository,
  auditEventsRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { extractEmailDomain } from '@balo/shared/domains';
import { personDisplayName } from '@balo/shared/parties';
import { log } from '@/lib/logging';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import {
  requestPhase,
  resolveRequestLens,
  resolveRequestDenialReason,
  type RequestViewerContext,
} from '@/lib/project-request/resolve-request-lens';
import { resolveEndedTrackView } from '@/lib/project-request/resolve-ended-track-view';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  resolveWorkspaceForEntity,
  workspaceSwitchRedirectPath,
} from '@/lib/workspaces/resolve-workspace-for-entity';
import {
  mapRequestToDetailView,
  type RequestDetailView,
  type ClosedSummaryInput,
  type KickoffUpfront,
} from '@/lib/project-request/request-detail-view';
import { ensureAdminBillingAutoskip } from '@/lib/project-request/ensure-admin-billing-autoskip';
import { loadAdminKickoffBilling } from '@/lib/project-request/load-admin-kickoff-billing';
import { loadKickoffUpfront } from '@/lib/project-request/kickoff-upfront';
import { listUpcomingCallsByThread } from '@/lib/project-request/upcoming-calls';
import type { AdminKickoffBillingView } from '@/lib/project-request/admin-kickoff-billing-view';
import { loadConversationView } from '@/lib/project-request/conversation-view';
import type { ConversationView } from '@/lib/project-request/conversation-view-types';
import { loadRequestFiles, type RequestFilesView } from '@/lib/request-files/load-request-files';
import { loadBaloPanel, type BaloPanelView } from '@/lib/project-request/load-balo-panel';
import {
  canManageBilling,
  type CapturedBillingDetails,
  type CompanyRole,
  type KickoffBillingCapture,
} from '@/lib/billing/billing-capture';
import { RequestDetailShell } from '@/components/balo/project-request/request-detail-shell';
import { ExpertEndedTrackView } from '@/components/balo/project-request/close/expert-ended-track-view';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';

interface RequestDetailPageProps {
  params: Promise<{ requestId: string }>;
}

/**
 * Request-scoped memo so `generateMetadata` and the page share a single DB read
 * per render (React `cache()` dedupes within one server request).
 */
const loadRequest = cache((requestId: string) =>
  projectRequestsRepository.findByIdWithRelations(requestId)
);

// Generic, leak-free metadata for any viewer who is not an authorised
// participant/observer of this request (or when the request is missing). It must
// not echo the real title or otherwise confirm the request exists.
const GENERIC_METADATA: Metadata = {
  title: 'Project request — Balo',
  // Private dashboard content — never indexed.
  robots: { index: false, follow: false },
};

/**
 * Client billing-capture context (BAL-323) — non-null ONLY for the client lens on
 * an active kickoff. Owners/admins get the captured details; a plain member's
 * payload carries `details: null`, so the tax ID / billing email never cross the
 * RSC boundary to a member.
 */
async function loadBillingCapture(
  ctx: RequestViewerContext,
  view: RequestDetailView,
  companyRole: CompanyRole,
  companyId: string
): Promise<KickoffBillingCapture | null> {
  if (ctx.lens !== 'client' || !view.kickoff) return null;
  const canManage = canManageBilling(companyRole);
  const row = canManage ? await companyBillingRepository.findByCompanyId(companyId) : undefined;
  const details: CapturedBillingDetails | null =
    row === undefined
      ? null
      : {
          legalName: row.legalName,
          countryCode: row.countryCode,
          taxId: row.taxId,
          address: row.address,
          billingEmail: row.billingEmail,
        };
  return { companyId, canManage, details };
}

/**
 * BAL-324 admin-only billing + payment-terms panel data. Only the observer (admin) lens
 * with an active kickoff board pays for the extra reads.
 */
async function loadAdminBilling(
  ctx: RequestViewerContext,
  view: RequestDetailView,
  companyId: string
): Promise<AdminKickoffBillingView | null> {
  if (ctx.archetype !== 'observer' || !view.kickoff) return null;
  return loadAdminKickoffBilling(companyId, view.kickoff.acceptedRelationshipId);
}

/**
 * The kickoff checklist's upfront amount — whether the deal has invoice steps at all, and
 * the client's fee-inclusive invoice figure. The expert lens never sees a client price (the
 * same audience rule as `hydrateReviewDoc`), so it gets the steps without the amount.
 */
async function loadKickoffUpfrontFor(
  ctx: RequestViewerContext,
  view: RequestDetailView
): Promise<KickoffUpfront | null> {
  if (!view.kickoff) return null;
  const upfront = await loadKickoffUpfront(view.kickoff.acceptedRelationshipId);
  if (upfront === null || ctx.lens !== 'expert') return upfront;
  return { ...upfront, amountCents: null };
}

/**
 * BAL-616 — the soonest upcoming call on the won thread while kickoff is still pending, so the
 * kickoff board's call row can read "Booked for …" for EVERY lens (an admin has no conversation
 * stage). Only the pre-kickoff `request_interaction` context is read: once kickoff is approved
 * the board's row is gone. The relationship id comes from the authorised request row, never from
 * input. A failed read degrades to `null` (the row offers "Pick a time" instead) rather than
 * breaking the page.
 */
async function loadKickoffNextCallStartIso(
  view: RequestDetailView,
  requestId: string
): Promise<string | null> {
  if (view.kickoff === null || view.kickoff.approved) return null;
  const relationshipId = view.kickoff.acceptedRelationshipId;
  try {
    const byThread = await listUpcomingCallsByThread({
      relationshipIds: [relationshipId],
      projectCall: null,
      nowMs: Date.now(),
    });
    const [next] = byThread.get(relationshipId) ?? [];
    return next?.scheduledStartIso ?? null;
  } catch (error) {
    log.warn('Kickoff next-call read failed — the board offers "Pick a time"', {
      requestId,
      relationshipId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The `project_request.closed` audit row's `metadata.counts` shape (narrowed, never cast). */
interface CloseAuditCounts {
  tracksDeclined: number;
  proposalsWithdrawn: number;
  meetingsCancelled: number;
}

/** Narrow the audit row's `unknown` metadata to its counts, defensively (0 on anything unexpected). */
function parseCloseAuditCounts(metadata: unknown): CloseAuditCounts {
  const fallback: CloseAuditCounts = {
    tracksDeclined: 0,
    proposalsWithdrawn: 0,
    meetingsCancelled: 0,
  };
  if (typeof metadata !== 'object' || metadata === null) return fallback;
  const counts = (metadata as Record<string, unknown>).counts;
  if (typeof counts !== 'object' || counts === null) return fallback;
  const c = counts as Record<string, unknown>;
  return {
    tracksDeclined: typeof c.tracksDeclined === 'number' ? c.tracksDeclined : 0,
    proposalsWithdrawn: typeof c.proposalsWithdrawn === 'number' ? c.proposalsWithdrawn : 0,
    meetingsCancelled: typeof c.meetingsCancelled === 'number' ? c.meetingsCancelled : 0,
  };
}

/**
 * BAL-540 — the two reads `deriveClosedSummary` needs, done ONCE here so the pure mapper stays
 * I/O-free. Returns `null` for a live request (no extra reads) or when `closedByUserId` is
 * unexpectedly absent (a data anomaly — every close writes it — handled defensively rather than
 * thrown).
 */
async function loadClosedSummaryInput(
  request: ProjectRequestWithRelations,
  requestId: string
): Promise<ClosedSummaryInput | null> {
  if (request.status !== 'closed' || request.closedByUserId === null) return null;

  const [closer, auditRow] = await Promise.all([
    usersRepository.findNamesByIds([request.closedByUserId]),
    auditEventsRepository.findLatestByEntityAndAction({
      entityType: 'project_request',
      entityId: requestId,
      action: 'project_request.closed',
    }),
  ]);
  const [closerRow] = closer;
  const closedByName =
    closerRow === undefined
      ? 'A team member'
      : personDisplayName(closerRow.firstName, closerRow.lastName, 'A team member');
  const rawCounts = parseCloseAuditCounts(auditRow?.metadata);

  return {
    closedByName,
    counts: {
      tracksEnded: rawCounts.tracksDeclined,
      proposalsWithdrawn: rawCounts.proposalsWithdrawn,
      meetingsCancelled: rawCounts.meetingsCancelled,
    },
  };
}

/**
 * BAL-540 — the three `RequestDetailShell` close/decline-control booleans. The two CLIENT
 * affordances (close the whole request; decline ONE track from the conversation thread) are the
 * SAME right — membership `MANAGE_REQUESTS` (D7) — so they resolve from ONE async, DB-backed
 * capability read. The admin arm is the pure, sync platform-capability check.
 *
 * ⚠ `canDecline` IS NOT OPTIONAL PLUMBING. It was missing on the first pass, which left the
 * client-lens decline control (`ThreadHeader`'s icon button / `MobileOverflowSheet`'s row,
 * both gated on `ConversationStage`'s `canDecline`, which defaults `false`) permanently
 * unreachable in production while 11,024 tests stayed green — every one of them injected the
 * prop below the seam. `page.test.tsx`'s "client member with MANAGE_REQUESTS sees the decline
 * control" renders page → shell → ConversationStage for real and is what now holds this
 * together.
 *
 * Extracted so the page body's cognitive complexity stays budgeted — booleans only, the shell
 * never re-derives authorization from a role/lens (ADR-1029).
 */
async function resolveCloseCapabilities(
  user: SessionUser,
  ctx: RequestViewerContext,
  companyId: string
): Promise<{ canClose: boolean; canCloseAsAdmin: boolean; canDecline: boolean }> {
  const manageRequests =
    ctx.lens === 'client'
      ? await hasCapability(user, CAPABILITIES.MANAGE_REQUESTS, { companyId })
      : false;
  const canCloseAsAdmin =
    ctx.lens === 'admin' && hasPlatformCapability(user, PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST);
  return { canClose: manageRequests, canCloseAsAdmin, canDecline: manageRequests };
}

/**
 * BAL-540 deviation V1 — the `!ctx` branch's FIRST check: the ONE surface a de-participated
 * expert may still open (their own ended track — declined, or the whole request closed).
 * `resolveRequestLens` stays untouched (D13) — this is a SECOND, strictly narrower branch
 * consulted only after it returns `null`. Falls through to the existing denial helper
 * (always throws) when there is no ended-track view to show. Extracted so the page body's
 * cognitive complexity stays budgeted.
 */
async function resolveNonParticipantResponse(
  user: SessionUser,
  request: ProjectRequestWithRelations,
  requestId: string
): Promise<React.JSX.Element> {
  const endedTrackView = resolveEndedTrackView(user, request);
  if (endedTrackView !== null) {
    return (
      <>
        <EntityCrumb label={request.title} />
        <ExpertEndedTrackView view={endedTrackView} />
      </>
    );
  }
  await redirectOrDenyRequestAccess(user, request, requestId);
  // Unreachable — the helper above always throws (redirect() or notFound()).
  throw new Error('unreachable: redirectOrDenyRequestAccess must throw');
}

/**
 * The `!ctx` (non-participant) branch: BAL-494 / ADR-1053 cross-workspace
 * deep-link redirect, or the classic not-a-participant denial → notFound().
 * Extracted from the page body to keep its own Cognitive Complexity within
 * budget — this function always throws (`redirect()` or `notFound()`) and
 * never returns normally.
 */
async function redirectOrDenyRequestAccess(
  user: SessionUser,
  request: ProjectRequestWithRelations,
  requestId: string
): Promise<never> {
  // BAL-494 / ADR-1053 — the viewer may hold ANOTHER workspace that owns this request.
  // Persist the switch via the Route Handler and come back — never a write during render.
  // Placed BEFORE the denial logging/analytics: a legitimate cross-workspace deep link is
  // not a denial and must not pollute REQUEST_ACCESS_DENIED.
  const target = await resolveWorkspaceForEntity(user, { companyId: request.companyId });
  if (target !== null) {
    // The redirect path carries a SHORT-TTL SEALED token (minted here, redeemed once by the
    // Route Handler) rather than a raw `to=` param — see `lib/workspaces/switch-token.ts`.
    redirect(await workspaceSwitchRedirectPath(user.id, target, `/projects/${requestId}`));
  }

  // Authenticated but not a participant/owner/admin → same not-found page.
  // Distinguish a DECLINED expert (dropped out, still probing) from a plain
  // stranger so we can measure declined experts hitting the wall (BAL-276).
  const denialReason = resolveRequestDenialReason(user, request);
  log.warn('Project request access denied', {
    requestId,
    userId: user.id,
    companyId: user.companyId,
    reason: denialReason ?? 'not_a_participant',
  });
  if (denialReason === 'declined_relationship') {
    trackServerAndFlush(PROJECT_SERVER_EVENTS.REQUEST_ACCESS_DENIED, {
      request_id: requestId,
      reason: 'declined_relationship',
      lens_attempted: 'expert',
      distinct_id: user.id,
    });
  }
  notFound();
}

export async function generateMetadata({
  params,
}: Readonly<RequestDetailPageProps>): Promise<Metadata> {
  const { requestId } = await params;

  // Mirror the page body's gating BEFORE specialising the title: Next.js streams
  // the document `<title>` even when the body `notFound()`s, so authorising here
  // is what stops a non-participant from learning the request's title / existence.
  // The cached loader dedupes with the page body — no extra DB cost.
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;

    const request = await loadRequest(requestId);
    if (!request) return GENERIC_METADATA;

    const ctx = resolveRequestLens(user, request);
    if (!ctx) return GENERIC_METADATA;

    return {
      title: `${request.title} — Balo`,
      robots: { index: false, follow: false },
    };
  } catch {
    // Metadata is best-effort — the page itself surfaces load failures. Fall back
    // to the generic (leak-free) title rather than echoing anything.
    return GENERIC_METADATA;
  }
}

export default async function RequestDetailPage({
  params,
}: Readonly<RequestDetailPageProps>): Promise<React.JSX.Element> {
  const { requestId } = await params;

  // The (dashboard) layout gates onboarding/drift; guard the unauthenticated
  // case explicitly so a missing session redirects rather than 500s.
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let request: Awaited<ReturnType<typeof loadRequest>>;
  try {
    request = await loadRequest(requestId);
  } catch (error) {
    log.error('Failed to load project request detail', {
      requestId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  // Missing or soft-deleted → 404 (same copy as unauthorised — no existence leak).
  if (!request) {
    notFound();
  }

  const ctx = resolveRequestLens(user, request);
  if (!ctx) {
    return resolveNonParticipantResponse(user, request, requestId);
  }

  // BAL-324 repeat-company auto-skip: when an admin loads the board and the client
  // already has billing on file, confirm the outstanding `client_billing` gate and
  // re-read (UNCACHED) so the settled state renders this pass. No-op for everyone
  // else. Placed BEFORE the view is mapped so the kickoff projection reflects it.
  request = await ensureAdminBillingAutoskip(request, ctx.lens === 'admin');

  // BAL-540 — the closed-request summary's two async-resolved primitives (the closer's name +
  // the close audit row's counts). Skipped entirely for a live request — no extra reads.
  const closedSummaryInput = await loadClosedSummaryInput(request, requestId);

  const view = mapRequestToDetailView(request, ctx, new Date(), closedSummaryInput);

  const { canClose, canCloseAsAdmin, canDecline } = await resolveCloseCapabilities(
    user,
    ctx,
    request.companyId
  );

  // BAL-331 deep-link: once the request is `kickoff_approved` a delivery
  // engagement exists — resolve its id so the shell can surface the "View delivery
  // workspace" entry for every lens. `undefined` (no engagement yet / not that
  // status) → the link is omitted.
  // The request stays `kickoff_approved` after the project completes or is cancelled, so the
  // engagement's own status is read too: only an `active` one takes `project_call` bookings.
  let deliveryEngagementId: string | null = null;
  let deliveryActive = true;
  if (view.status === 'kickoff_approved') {
    const delivery = await projectEngagementsRepository.findByProjectRequestId(requestId);
    deliveryEngagementId = delivery?.id ?? null;
    deliveryActive = delivery?.status === 'active';
  }

  // Phase-2 participants get the live conversation payload (thread summaries +
  // the default thread's first page); a closed request's client gets its surviving threads,
  // read-only (an expert on a closed request has no lens and never reaches here).
  // Observers/Phase-1 never pay for it.
  let conversation: ConversationView | null = null;
  const phase = requestPhase(view.status);
  if (ctx.archetype === 'participant' && (phase === 'phase2' || phase === 'closed')) {
    // BAL-616 — the engagement id also routes the won thread's `project_call` calls into
    // its `upcomingCalls`, so it is resolved above and passed in.
    conversation = await loadConversationView(request, ctx, user, deliveryEngagementId);
  }

  const adminBilling = await loadAdminBilling(ctx, view, request.companyId);
  const billingCapture = await loadBillingCapture(ctx, view, user.companyRole, request.companyId);
  const kickoffUpfront = await loadKickoffUpfrontFor(ctx, view);

  const kickoffNextCallStartIso = await loadKickoffNextCallStartIso(view, requestId);

  // BAL-283 (D12) — the VIEWER's OWN email domain (never a counterparty's — ADR-1044 is not
  // engaged), for the intro-call dialog's guest composer disclosure. Same precedent as the
  // case surface (`cases/[engagementId]/page.tsx`).
  const viewerEmailDomain = extractEmailDomain(user.email);

  // BAL-431 / ADR-1048 — the request-file audience panel. Loaded for EVERY lens whenever the
  // request has at least one relationship — deliberately NOT gated on `requestPhase(...) ===
  // 'phase2'`. The loader decides who gets a panel: an expert whose track has not opened gets
  // `null` (no panel), and the client lists only experts whose tracks have opened.
  // `loadRequestFiles` runs its own `authorizeRequestFileScope` gate internally, so the load is
  // authorization-complete on its own.
  let requestFilesView: RequestFilesView | null = null;
  if (request.relationships.length > 0) {
    requestFilesView = await loadRequestFiles(user, requestId);
  }

  // BAL-541 — the "Balo" staff panel. Gated on `ctx.canSeeBaloPanel` (D13) so nobody else pays
  // for the extra reads; renders on a CLOSED request too (D5), which is why this sits outside
  // any `!isClosed` guard.
  let baloPanel: BaloPanelView | null = null;
  if (ctx.canSeeBaloPanel) {
    baloPanel = await loadBaloPanel(user, request);
  }

  return (
    <>
      {/* BAL-499 — publishes the request's title into the top bar's breadcrumb trail. Safe
          here: this is the already-authorised return path, after every gate above. */}
      <EntityCrumb label={request.title} />
      <RequestDetailShell
        view={view}
        ctx={ctx}
        conversation={conversation}
        adminBilling={adminBilling}
        billingCapture={billingCapture}
        kickoffUpfront={kickoffUpfront}
        deliveryEngagementId={deliveryEngagementId}
        deliveryActive={deliveryActive}
        kickoffNextCallStartIso={kickoffNextCallStartIso}
        viewerEmailDomain={viewerEmailDomain}
        requestFilesView={requestFilesView}
        canClose={canClose}
        canCloseAsAdmin={canCloseAsAdmin}
        canDecline={canDecline}
        baloPanel={baloPanel}
      />
    </>
  );
}
