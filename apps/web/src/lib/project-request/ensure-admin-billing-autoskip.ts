import 'server-only';
import {
  projectRequestsRepository,
  ensureClientBillingGateConfirmed,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { log } from '@/lib/logging';

/**
 * BAL-324 — repeat-company auto-skip in the admin board's READ path.
 *
 * When a repeat client already has billing details on file, the `client_billing`
 * kickoff gate should never show as outstanding to an admin. This confirms that
 * gate lazily, the first time an admin loads the board, then re-reads the row so
 * the admin sees the settled state immediately.
 *
 * No-op unless the viewer is an admin AND the request is `accepted` AND the gate
 * is still open (`clientBillingConfirmedAt === null`) — the same preconditions
 * `ensureClientBillingGateConfirmed` self-guards on (it additionally no-ops when
 * the company has no billing on file, and delegates the write to the
 * FOR-UPDATE-locked `confirmKickoffGate`, so this is idempotent + retry-safe).
 *
 * The re-read MUST be UNCACHED (a fresh `findByIdWithRelations`, not the page's
 * React-`cache()`-memoized `loadRequest`): `generateMetadata` primes that memo
 * before the page body runs, so a write-during-render would otherwise be invisible
 * to the already-cached row. On any failure we swallow + log a warning and return
 * the original request — a best-effort read-path convenience must never break the
 * page render.
 *
 * Scope is admin board load only (deliberate — see BAL-324). A repeat-company
 * CLIENT still sees a stale outstanding gate until an admin opens the board; that
 * limitation is accepted for this ticket.
 */
export async function ensureAdminBillingAutoskip(
  request: ProjectRequestWithRelations,
  isAdmin: boolean
): Promise<ProjectRequestWithRelations> {
  if (!isAdmin || request.status !== 'accepted' || request.clientBillingConfirmedAt !== null) {
    return request;
  }

  try {
    await ensureClientBillingGateConfirmed(request.id);
    const fresh = await projectRequestsRepository.findByIdWithRelations(request.id);
    return fresh ?? request;
  } catch (error) {
    log.warn('Auto-skip client billing gate failed', {
      requestId: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return request;
  }
}
