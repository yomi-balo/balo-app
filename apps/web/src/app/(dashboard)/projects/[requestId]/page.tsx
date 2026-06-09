import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { projectRequestsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { mapRequestToDetailView } from '@/lib/project-request/request-detail-view';
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
    log.warn('Project request access denied', {
      requestId,
      userId: user.id,
      companyId: user.companyId,
    });
    notFound();
  }

  const view = mapRequestToDetailView(request, ctx);

  return <RequestDetailShell view={view} ctx={ctx} />;
}
