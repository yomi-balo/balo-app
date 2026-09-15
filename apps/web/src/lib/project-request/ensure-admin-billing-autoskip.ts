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
 * ⚠ THIS IS NOW THE BACKSTOP, NOT THE PRIMARY PATH (BAL-343). The gate is confirmed at
 * PROPOSAL-ACCEPTANCE time, inside `runAcceptProposal`
 * (`projects/[requestId]/_actions/_shared/accept-proposal-core.ts`), so a repeat-company
 * CLIENT now sees the settled gate on its own request immediately. Two reasons this path
 * is RETAINED rather than deleted as redundant: (1) the acceptance-time call is
 * deliberately best-effort — it swallows every failure so it can never fail an accept
 * that already committed — and this path is what makes that swallowing acceptable; (2) it
 * is the ONLY confirm path for requests accepted BEFORE BAL-343 shipped, so a historical
 * row with billing on file and an outstanding gate is settled the first time an admin
 * opens it. Do not delete it.
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
