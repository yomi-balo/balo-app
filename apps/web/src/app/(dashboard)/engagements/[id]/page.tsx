import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { engagementsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { resolveEngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import { mapEngagementToWorkspaceView } from '@/lib/engagement/engagement-view';
import {
  trackServerAndFlush,
  ENGAGEMENT_SERVER_EVENTS,
  type EngagementWorkspaceEntry,
} from '@/lib/analytics/server';
import { EngagementWorkspace } from '@/components/balo/engagement/engagement-workspace';

interface EngagementWorkspacePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}

/**
 * Request-scoped memo so `generateMetadata` and the page share a single DB read
 * per render (React `cache()` dedupes within one server request) — mirrors the
 * project-request detail page.
 */
const loadEngagement = cache((id: string) =>
  engagementsRepository.findEngagementWithMilestones(id)
);

// Generic, leak-free metadata for any viewer who is not an authorised
// participant/observer of this engagement (or when it is missing). It must not
// echo the real title or otherwise confirm the engagement exists.
const GENERIC_METADATA: Metadata = {
  title: 'Delivery workspace — Balo',
  // Private dashboard content — never indexed.
  robots: { index: false, follow: false },
};

/**
 * Whitelist the `?from` query into the analytics `entry` union. Anything absent
 * or unrecognised (e.g. `?from=bogus`) collapses to `direct`.
 */
function resolveEntry(from: string | undefined): EngagementWorkspaceEntry {
  return from === 'request_detail' || from === 'inbox' ? from : 'direct';
}

export async function generateMetadata({
  params,
}: Readonly<EngagementWorkspacePageProps>): Promise<Metadata> {
  const { id } = await params;

  // Mirror the page body's gating BEFORE specialising the title: Next.js streams
  // the document `<title>` even when the body `notFound()`s, so authorising here
  // is what stops a non-participant from learning the engagement's title /
  // existence. The cached loader dedupes with the page body — no extra DB cost.
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;

    const engagement = await loadEngagement(id);
    if (!engagement) return GENERIC_METADATA;

    const ctx = resolveEngagementLens(user, engagement);
    if (!ctx) return GENERIC_METADATA;

    const view = mapEngagementToWorkspaceView(engagement, ctx);
    return {
      title: `${view.header.engagementTitle} — Balo`,
      robots: { index: false, follow: false },
    };
  } catch {
    // Metadata is best-effort — the page itself surfaces load failures. Fall back
    // to the generic (leak-free) title rather than echoing anything.
    return GENERIC_METADATA;
  }
}

export default async function EngagementWorkspacePage({
  params,
  searchParams,
}: Readonly<EngagementWorkspacePageProps>): Promise<React.JSX.Element> {
  const { id } = await params;

  // The (dashboard) layout gates onboarding/drift; guard the unauthenticated
  // case explicitly so a missing session redirects rather than 500s.
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let engagement: Awaited<ReturnType<typeof loadEngagement>>;
  try {
    engagement = await loadEngagement(id);
  } catch (error) {
    log.error('Failed to load engagement workspace', {
      engagementId: id,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  // Missing or soft-deleted → 404 (same copy as unauthorised — no existence leak).
  if (!engagement) {
    notFound();
  }

  const ctx = resolveEngagementLens(user, engagement);
  if (!ctx) {
    // Authenticated but not the client owner / delivering expert / admin → same
    // not-found page (existence never leaks to a stranger).
    log.warn('Engagement access denied', {
      engagementId: id,
      userId: user.id,
      companyId: user.companyId,
    });
    notFound();
  }

  const view = mapEngagementToWorkspaceView(engagement, ctx);

  // Fire the server-side view event on the authorised path. `after()` is
  // registered here (before any later throw) so the flush lands even on
  // serverless. Entry is derived from the whitelisted `?from` query.
  const { from } = await searchParams;
  trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.WORKSPACE_VIEWED, {
    engagement_id: engagement.id,
    lens: ctx.lens,
    entry: resolveEntry(from),
    engagement_status: engagement.status,
    distinct_id: user.id,
  });

  return <EngagementWorkspace view={view} />;
}
