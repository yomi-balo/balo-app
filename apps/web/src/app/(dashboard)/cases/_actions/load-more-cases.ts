'use server';

import 'server-only';

import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import {
  loadMoreOpenCasesPage,
  loadResolvedCasesPage,
  resolveCasesIndexRequest,
  type CasesIndexRequest,
} from '../_lib/load-cases-index';
import type {
  LoadMoreOpenCasesResult,
  LoadMoreResolvedCasesResult,
} from '../_lib/cases-index-view-types';
import {
  loadMoreOpenCasesSchema,
  loadMoreResolvedCasesSchema,
  type LoadMoreOpenCasesInput,
  type LoadMoreResolvedCasesInput,
} from './cases-index-schema';

/**
 * BAL-567 — the `/cases` index's two READ-ONLY "show more" Server Actions.
 *
 * ⚠⚠ THE SCOPE IS RE-DERIVED FROM THE SESSION ON EVERY CALL, AND THE PARTICIPATION GATE IS
 * RE-RUN. Both actions take ONLY a cursor. Accepting a `companyId` would hand a caller another
 * tenant's cases, because `casesIndexRepository` makes no authorization decision of its own; and
 * re-using a scope resolved when the page first rendered would let a 7-day session cookie
 * outlive a membership removal.
 *
 * ⚠ READS, NOT MUTATIONS, so the bar is `getCurrentUser()` plus that gate rather than
 * `requireOnboardedUser()` (memory `reference_web_mutating_server_action_requires_onboarded_user`
 * is about mutating actions). Nothing here writes, queues, or notifies.
 *
 * ⚠ ONE GENERIC REFUSAL STRING FOR EVERY DENIAL — not-signed-in, not-a-participant, and an
 * expert-mode session with no profile all return the same message, so the action cannot be used
 * as an oracle for which of those a caller is.
 */

const CANNOT_LOAD = 'We couldn’t load more cases. Try again in a moment.';

/** The session's request, or `null` for any reason the caller must not be able to distinguish. */
async function resolveActorRequest(): Promise<{
  viewerUserId: string;
  request: CasesIndexRequest;
} | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const request = resolveCasesIndexRequest(user);
  return request === null ? null : { viewerUserId: user.id, request };
}

export async function loadMoreOpenCases(
  input: LoadMoreOpenCasesInput
): Promise<LoadMoreOpenCasesResult> {
  const actor = await resolveActorRequest();
  if (actor === null) return { success: false, error: CANNOT_LOAD };

  const parsed = loadMoreOpenCasesSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: CANNOT_LOAD };

  try {
    const page = await loadMoreOpenCasesPage({ ...actor, after: parsed.data.cursor });
    // `null` ⇒ the participation gate denied. Same string as every other refusal.
    if (page === null) return { success: false, error: CANNOT_LOAD };
    return { success: true, rows: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
  } catch (error) {
    log.error('Failed to load more open cases', {
      userId: actor.viewerUserId,
      workspaceType: actor.request.side,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: CANNOT_LOAD };
  }
}

export async function loadMoreResolvedCases(
  input: LoadMoreResolvedCasesInput
): Promise<LoadMoreResolvedCasesResult> {
  const actor = await resolveActorRequest();
  if (actor === null) return { success: false, error: CANNOT_LOAD };

  const parsed = loadMoreResolvedCasesSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: CANNOT_LOAD };

  try {
    const page = await loadResolvedCasesPage({
      ...actor,
      after: parsed.data.cursor ?? undefined,
    });
    if (page === null) return { success: false, error: CANNOT_LOAD };
    return { success: true, rows: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
  } catch (error) {
    log.error('Failed to load resolved cases', {
      userId: actor.viewerUserId,
      workspaceType: actor.request.side,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: CANNOT_LOAD };
  }
}
