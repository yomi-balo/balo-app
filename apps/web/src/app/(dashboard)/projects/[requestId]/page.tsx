import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { projectRequestsRepository, companyBillingRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import {
  requestPhase,
  resolveRequestLens,
  resolveRequestDenialReason,
  type RequestViewerContext,
} from '@/lib/project-request/resolve-request-lens';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  mapRequestToDetailView,
  type RequestDetailView,
} from '@/lib/project-request/request-detail-view';
import { loadConversationView } from '@/lib/project-request/conversation-view';
import type { ConversationView } from '@/lib/project-request/conversation-view-types';
import {
  canManageBilling,
  type CapturedBillingDetails,
  type CompanyRole,
  type KickoffBillingCapture,
} from '@/lib/billing/billing-capture';
import { RequestDetailShell } from '@/components/balo/project-request/request-detail-shell';

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

  const view = mapRequestToDetailView(request, ctx);

  // Phase-2 participants get the live conversation payload (thread summaries +
  // the default thread's first page). Observers/Phase-1 never pay for it.
  let conversation: ConversationView | null = null;
  if (ctx.archetype === 'participant' && requestPhase(view.status) === 'phase2') {
    conversation = await loadConversationView(request, ctx, user);
  }

  const billingCapture = await loadBillingCapture(ctx, view, user.companyRole, request.companyId);

  return (
    <RequestDetailShell
      view={view}
      ctx={ctx}
      conversation={conversation}
      billingCapture={billingCapture}
    />
  );
}
