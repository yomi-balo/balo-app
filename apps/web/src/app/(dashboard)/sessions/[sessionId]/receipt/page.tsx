import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { trackServerAndFlush, CASE_BILLING_SERVER_EVENTS } from '@/lib/analytics/server';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';
import { loadSessionStatement } from '../_lib/load-session-statement';
import { resolveStatementEntrySource } from '../_lib/resolve-statement-source';
import { STATEMENT_COPY } from '../_lib/statement-copy';
import { StatementShell } from '../_components/statement-shell';

interface ReceiptPageProps {
  /** ⚠ NEXT 16 — `params` AND `searchParams` are Promises. They MUST be awaited. */
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ from?: string }>;
}

/**
 * Generic, leak-free metadata for any viewer who is not the authorised CLIENT of this session
 * (or when it is missing). Must not echo the real title or otherwise confirm the session exists.
 */
const GENERIC_METADATA: Metadata = {
  title: 'Session receipt — Balo',
  robots: { index: false, follow: false },
};

export async function generateMetadata({ params }: Readonly<ReceiptPageProps>): Promise<Metadata> {
  const { sessionId } = await params;
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;
    const view = await loadSessionStatement(sessionId, user.id, 'client');
    if (view === null) return GENERIC_METADATA;
    const title = view.title ?? STATEMENT_COPY.client.fallbackTitle;
    return { title: title + ' — Balo', robots: { index: false, follow: false } };
  } catch {
    return GENERIC_METADATA;
  }
}

/**
 * BAL-441 — `/sessions/:id/receipt`, the CLIENT lens. A finished consultation moves real money —
 * this page is the durable statement of what a client company was charged, something a billing
 * admin can open from a bookmark six weeks later and understand immediately.
 *
 * ⚠ `getCurrentUser()` + `redirect('/login')`, NOT `requireUser()` — see plan §C2. The primary
 * use case here is a bookmarked link opened long after the session: `requireUser()` would send
 * that viewer to the error boundary instead of the login screen, the worst outcome this page can
 * produce. The onboarding refusal still happens one layer down, in `resolveSessionApiAuth`.
 *
 * ⚠ ONE `notFound()` WITH ONE COPY for missing, soft-deleted, unauthorised AND wrong-lens (an
 * expert who opens `/receipt`). A distinct outcome would confirm the session exists to a
 * stranger — the api's `resolveSessionLens` already refuses a 403 for exactly this reason.
 */
export default async function ReceiptPage({
  params,
  searchParams,
}: Readonly<ReceiptPageProps>): Promise<React.JSX.Element> {
  const { sessionId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let view: Awaited<ReturnType<typeof loadSessionStatement>>;
  try {
    view = await loadSessionStatement(sessionId, user.id, 'client');
  } catch (error) {
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
    lens: 'client',
    source: resolveStatementEntrySource(from),
    statement_state: view.block.state,
    ...(view.block.settlementShape === undefined
      ? {}
      : { settlement_shape: view.block.settlementShape }),
    distinct_id: user.id,
  });

  return (
    <>
      <EntityCrumb label="Receipt" />
      <StatementShell view={view} />
    </>
  );
}
