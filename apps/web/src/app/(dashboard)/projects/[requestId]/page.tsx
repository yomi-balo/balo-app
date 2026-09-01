import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  projectRequestsRepository,
  companyBillingRepository,
  projectEngagementsRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { extractEmailDomain } from '@balo/shared/domains';
import { log } from '@/lib/logging';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import {
  requestPhase,
  resolveRequestLens,
  resolveRequestDenialReason,
  type RequestViewerContext,
} from '@/lib/project-request/resolve-request-lens';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  resolveWorkspaceForEntity,
  workspaceSwitchRedirectPath,
} from '@/lib/workspaces/resolve-workspace-for-entity';
import {
  mapRequestToDetailView,
  type RequestDetailView,
} from '@/lib/project-request/request-detail-view';
import { ensureAdminBillingAutoskip } from '@/lib/project-request/ensure-admin-billing-autoskip';
import { loadAdminKickoffBilling } from '@/lib/project-request/load-admin-kickoff-billing';
import type { AdminKickoffBillingView } from '@/lib/project-request/admin-kickoff-billing-view';
import { loadConversationView } from '@/lib/project-request/conversation-view';
import type { ConversationView } from '@/lib/project-request/conversation-view-types';
import { loadRequestFiles, type RequestFilesView } from '@/lib/request-files/load-request-files';
import {
  canManageBilling,
  type CapturedBillingDetails,
  type CompanyRole,
  type KickoffBillingCapture,
} from '@/lib/billing/billing-capture';
import { RequestDetailShell } from '@/components/balo/project-request/request-detail-shell';
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
    await redirectOrDenyRequestAccess(user, request, requestId);
    // Unreachable — the helper above always throws (redirect() or notFound()).
    throw new Error('unreachable: redirectOrDenyRequestAccess must throw');
  }

  // BAL-324 repeat-company auto-skip: when an admin loads the board and the client
  // already has billing on file, confirm the outstanding `client_billing` gate and
  // re-read (UNCACHED) so the settled state renders this pass. No-op for everyone
  // else. Placed BEFORE the view is mapped so the kickoff projection reflects it.
  request = await ensureAdminBillingAutoskip(request, ctx.lens === 'admin');

  const view = mapRequestToDetailView(request, ctx);

  // Phase-2 participants get the live conversation payload (thread summaries +
  // the default thread's first page). Observers/Phase-1 never pay for it.
  let conversation: ConversationView | null = null;
  if (ctx.archetype === 'participant' && requestPhase(view.status) === 'phase2') {
    conversation = await loadConversationView(request, ctx, user);
  }

  // BAL-324 admin-only billing + payment-terms panel data. Only the observer
  // (admin) lens with an active kickoff board pays for the extra reads.
  let adminBilling: AdminKickoffBillingView | null = null;
  if (ctx.archetype === 'observer' && view.kickoff) {
    adminBilling = await loadAdminKickoffBilling(
      request.companyId,
      view.kickoff.acceptedRelationshipId
    );
  }

  const billingCapture = await loadBillingCapture(ctx, view, user.companyRole, request.companyId);

  // BAL-331 deep-link: once the request is `kickoff_approved` a delivery
  // engagement exists — resolve its id so the shell can surface the "View delivery
  // workspace" entry for every lens. `undefined` (no engagement yet / not that
  // status) → the link is omitted.
  let deliveryEngagementId: string | null = null;
  if (view.status === 'kickoff_approved') {
    deliveryEngagementId =
      (await projectEngagementsRepository.findIdByProjectRequestId(requestId)) ?? null;
  }

  // BAL-283 (D12) — the VIEWER's OWN email domain (never a counterparty's — ADR-1044 is not
  // engaged), for the intro-call dialog's guest composer disclosure. Same precedent as the
  // case surface (`cases/[engagementId]/page.tsx`).
  const viewerEmailDomain = extractEmailDomain(user.email);

  // BAL-431 / ADR-1048 — the request-file audience panel. Rendered for EVERY lens whenever the
  // request has at least one relationship — deliberately NOT gated on `requestPhase(...) ===
  // 'phase2'` (an `invited` expert must see share-to-all files the moment their track exists,
  // the ticket's headline scenario). `loadRequestFiles` runs its own `authorizeRequestFileScope`
  // gate internally, so the load is authorization-complete on its own.
  let requestFilesView: RequestFilesView | null = null;
  if (request.relationships.length > 0) {
    requestFilesView = await loadRequestFiles(user, requestId);
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
        deliveryEngagementId={deliveryEngagementId}
        viewerEmailDomain={viewerEmailDomain}
        requestFilesView={requestFilesView}
      />
    </>
  );
}
