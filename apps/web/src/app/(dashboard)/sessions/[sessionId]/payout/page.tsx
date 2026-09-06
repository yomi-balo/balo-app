import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { trackServerAndFlush, CASE_BILLING_SERVER_EVENTS } from '@/lib/analytics/server';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';
import {
  loadSessionStatement,
  SessionStatementRateLimitedError,
} from '../_lib/load-session-statement';
import { resolveStatementEntrySource } from '../_lib/resolve-statement-source';
import { STATEMENT_COPY } from '../_lib/statement-copy';
import { StatementShell } from '../_components/statement-shell';
import { StatementRateLimited } from '../_components/statement-rate-limited';

interface PayoutPageProps {
  /** ⚠ NEXT 16 — `params` AND `searchParams` are Promises. They MUST be awaited. */
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ from?: string }>;
}

/**
 * Generic, leak-free metadata for any viewer who is not the authorised EXPERT of this session
 * (or when it is missing). Must not echo the real title or otherwise confirm the session exists.
 */
const GENERIC_METADATA: Metadata = {
  title: 'Payout statement — Balo',
  robots: { index: false, follow: false },
};

export async function generateMetadata({ params }: Readonly<PayoutPageProps>): Promise<Metadata> {
  const { sessionId } = await params;
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;
    const view = await loadSessionStatement(sessionId, user.id, 'expert');
    if (view === null) return GENERIC_METADATA;
    const title = view.title ?? STATEMENT_COPY.expert.fallbackTitle;
    return { title: title + ' — Balo', robots: { index: false, follow: false } };
  } catch {
    return GENERIC_METADATA;
  }
}

/**
 * BAL-441 — `/sessions/:id/payout`, the EXPERT lens. The durable statement of what an expert
 * earned for a finished consultation — something an expert may forward without annotation.
 *
 * ⚠ `getCurrentUser()` + `redirect('/login')`, NOT `requireUser()` — see plan §C2.
 *
 * ⚠ ONE `notFound()` WITH ONE COPY for missing, soft-deleted, unauthorised AND wrong-lens (a
 * client who opens `/payout`). Existence stays hidden.
 */
export default async function PayoutPage({
  params,
  searchParams,
}: Readonly<PayoutPageProps>): Promise<React.JSX.Element> {
  const { sessionId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let view: Awaited<ReturnType<typeof loadSessionStatement>>;
  try {
    view = await loadSessionStatement(sessionId, user.id, 'expert');
  } catch (error) {
    // BAL-519 — the api's per-user limiter refused this read. A calm INLINE state, never
    // `error.tsx` (whose copy says "this is on our side" — untrue here) and never `notFound()`
    // (which would say the payout does not exist). NO `SESSION_STATEMENT_VIEWED` event: we return
    // before the tracking call, the same structural rule as the `notFound()` path.
    if (error instanceof SessionStatementRateLimitedError) {
      log.warn('Session statement page rate-limited', {
        sessionId,
        userId: user.id,
        lens: 'expert',
      });
      return <StatementRateLimited lens="expert" sessionId={sessionId} />;
    }
    log.error('Failed to load session statement', {
      sessionId,
      userId: user.id,
      errorMessage: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  if (view === null) {
    notFound();
  }

  const { from } = await searchParams;

  trackServerAndFlush(CASE_BILLING_SERVER_EVENTS.SESSION_STATEMENT_VIEWED, {
    session_id: sessionId,
    lens: 'expert',
    source: resolveStatementEntrySource(from),
    statement_state: view.block.state,
    ...(view.block.settlementShape === undefined
      ? {}
      : { settlement_shape: view.block.settlementShape }),
    distinct_id: user.id,
  });

  return (
    <>
      <EntityCrumb label="Payout" />
      <StatementShell view={view} />
    </>
  );
}
