import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import type { CaseSurfaceState } from '@/lib/analytics/server';
import type { CaseHeaderView } from '@/lib/cases/case-view-types';
import { loadCase } from './_lib/load-case';
import { CaseSurface } from './_components/case-surface';

interface CasePageProps {
  /** ⚠ NEXT 16 — `params` IS A PROMISE. It MUST be awaited. */
  params: Promise<{ engagementId: string }>;
}

/**
 * Generic, leak-free metadata for any viewer who is not an authorised participant of this case
 * (or when it is missing). It must not echo the real title or otherwise confirm the case
 * exists.
 */
const GENERIC_METADATA: Metadata = {
  title: 'Case — Balo',
  robots: { index: false, follow: false },
};

export async function generateMetadata({ params }: Readonly<CasePageProps>): Promise<Metadata> {
  const { engagementId } = await params;

  // ⚠ THE FULL GATE RUNS HERE TOO, BEFORE THE TITLE IS SPECIALISED. Next streams the document
  // title even when the body `notFound()`s, so authorising here is what stops a non-participant
  // learning the case's subject — or that it exists at all. `loadCase` is `cache()`d, so this
  // shares one set of reads with the page body; there is no extra DB cost.
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;

    const view = await loadCase(engagementId, user.id);
    if (view === null) return GENERIC_METADATA;

    return { title: view.header.title + ' — Balo', robots: { index: false, follow: false } };
  } catch {
    // Metadata is best-effort — the page itself surfaces load failures. Fall back to the
    // generic (leak-free) title rather than echoing anything.
    return GENERIC_METADATA;
  }
}

/**
 * BAL-421 — THE CASE SURFACE. One case: what it is about, what has happened on it, what is
 * still owed, and the one decision that ends it.
 *
 * ⚠ NEXT 16: `params` is a PROMISE and is awaited above.
 *
 * ⚠⚠ ONE `notFound()` WITH ONE COPY for missing, soft-deleted, cross-tenant, no-capability,
 * no-expert-profile, no-thread AND not-a-case. A distinct 403 would confirm the case exists,
 * which makes the page an existence oracle over every `engagements.id` on the platform —
 * readable by any self-serve signup. The DENIAL SHAPE is already in Axiom (the underlying gate
 * logs a distinct `reason`); only the wire is uniform.
 *
 * ⚠ THERE IS NO ADMIN LENS, DELIBERATELY. `authorizeEngagementConversation` has no admin arm,
 * so a platform admin who is neither a company member nor on the expert side gets the SAME
 * 404. A fourth lens is a separate authorization surface with its own money rules; platform
 * staff use the admin engagements list. There is no dead `admin` branch anywhere in this
 * feature, because a reserved arm nothing can reach reads as coverage that does not exist.
 *
 * ⚠ THE LENS BRANCH LIVES IN THE VIEW MODEL, NOT IN A FLAG. `CaseSurfaceView` is a
 * discriminated union, so the client arm cannot carry an earnings figure and the expert arm
 * cannot carry `canClose`.
 */
export default async function CasePage({
  params,
}: Readonly<CasePageProps>): Promise<React.JSX.Element> {
  const { engagementId } = await params;

  // The (dashboard) layout gates onboarding/drift; guard the unauthenticated case explicitly
  // so a missing session redirects rather than 500s.
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let view: Awaited<ReturnType<typeof loadCase>>;
  try {
    view = await loadCase(engagementId, user.id);
  } catch (error) {
    log.error('Failed to load case surface', {
      engagementId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  if (view === null) {
    // The gate already logged the DENIAL SHAPE. One copy on the wire.
    notFound();
  }

  // ⚠ A SERVER EVENT, REGISTERED ON THE AUTHORISED PATH AND BEFORE ANY LATER THROW, so the
  // flush lands on serverless even if the render fails downstream. A CLIENT event would fire
  // before authorization was observable — a denied viewer could still register a view.
  trackServerAndFlush(RECAP_SERVER_EVENTS.CASE_SURFACE_VIEWED, {
    lens: view.lens,
    consultation_count: view.consultations.length,
    case_state: resolveCaseState(view.header),
    distinct_id: user.id,
  });

  return <CaseSurface view={view} />;
}

/**
 * `open` / `resolved` / `auto_inactive`.
 *
 * ⚠ THE TWO CLOSED REASONS STAY DISTINCT rather than collapsing to one `closed`. Whether cases
 * are being deliberately resolved or merely going quiet is the most useful thing this
 * dimension can report, and it is unrecoverable once the two are merged.
 */
function resolveCaseState(header: CaseHeaderView): CaseSurfaceState {
  if (header.isOpen) return 'open';
  return header.closeReason === 'auto_inactive' ? 'auto_inactive' : 'resolved';
}
