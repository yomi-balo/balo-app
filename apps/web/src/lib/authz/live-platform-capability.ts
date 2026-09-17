import 'server-only';

import { usersRepository } from '@balo/db';
import type { PlatformCapability } from '@balo/shared/authz';
import { sealedPlatformCapabilities } from '@/lib/auth/session-platform-capabilities';
import { log } from '@/lib/logging';
import { hasPlatformCapability } from './platform';

/**
 * BAL-560 fix round 1 (security F2) — **THE LIVE-ROW PLATFORM GATE FOR MUTATING SERVER ACTIONS.**
 *
 * ⚠⚠ WHY THIS EXISTS. `apps/web` resolves the platform axis from the SEALED SESSION (D6), and
 * `checkSessionDrift` keeps that cookie honest — but it only runs during a PAGE RENDER. A Server
 * Action POSTs straight to its own endpoint: no render happens first, so drift never fires and
 * the action gates on whatever was sealed, for up to the full seven-day cookie lifetime. A
 * revoked per-user override is therefore NOT enforced on a Server Action invoked from a page the
 * person already has open — which is exactly the window an auditor would use.
 *
 * ⚠ THE PRECEDENT IS ALREADY IN THE TREE, AND THIS GENERALISES IT. The impersonation entry point
 * (`lib/auth/actions/impersonation.ts`) re-reads the actor for precisely this reason, and says so
 * in its own words: the cookie "can be up to seven days stale: a demoted, suspended or deleted
 * staff member would otherwise keep the most powerful capability in the product until their
 * cookie expired. One extra query, on the rarest path in the app." Staff mutations are all rare
 * paths; one indexed primary-key read is the right price for a revocation boundary.
 *
 * ⚠ IT RE-CHECKS LIVENESS TOO, NOT JUST THE CAPABILITY. `deletedAt` / `status` are read from the
 * same row, so a suspended or soft-deleted staff member is refused here even though their cookie
 * still says otherwise — the same three conditions the impersonation gate applies, in the same
 * order.
 *
 * ⚠ IT DOES NOT REPLACE THE SESSION GATE, IT FOLLOWS IT. Call sites keep their existing
 * `getCurrentUser()` / `requireOnboardedUser()` + `hasPlatformCapability(...)` check: that one is
 * synchronous, free, and fails closed on an unauthenticated caller before this read is spent.
 * This is the second, authoritative gate.
 *
 * ⚠ NOT FOR READ-ONLY LOADERS. A stale read shows data the person could already see one render
 * ago and grants nothing; paying a query on every `load-more-*` / `fetch-lookup-*` call would be
 * cost without a security boundary. The exceptions are enumerated, each with its reason, in
 * `invariants/platform-capability-live-gate.test.ts`.
 *
 * ⚠ NOT FOR THE EDGE, AND NOT FOR A LENS RESOLVER. It is `async` and imports `@balo/db`, so it is
 * illegal in `middleware.ts` and would break the "Pure + synchronous — no I/O" contract that
 * `resolve-request-lens.ts` and `resolve-engagement-lens.ts` publish. Those stay on the session
 * seam by design (D5).
 *
 * ⚠⚠ **IT SWALLOWS ITS OWN DB FAILURE AND DENIES — AND THAT IS WHY IT, NOT THE CALL SITE, OWNS
 * THE `try` (fix round 3, R4).** Every call site places this gate ABOVE its own `try` block and
 * above its own `safeParse`, because the documented ordering is "the capability is resolved
 * BEFORE the input is parsed" — that is what stops a caller without the capability from learning,
 * from the shape of the error, whether their input was even well-formed (no existence leak).
 * Moving the gate down into the surrounding `try` to get error handling would move it AFTER the
 * parse and break that ordering. So the error handling lives here instead: a throwing read logs
 * and returns `false`, and the call site's existing `PERMISSION_DENIED` arm renders the normal
 * failure message rather than the action crashing with an unhandled rejection.
 *
 * FAILING CLOSED IS THE ONLY DEFENSIBLE DIRECTION for an authorization read: an unreachable
 * database must not be a way to keep a revoked capability.
 */
export async function actorHoldsPlatformCapability(
  userId: string,
  capability: PlatformCapability
): Promise<boolean> {
  let row: Awaited<ReturnType<typeof usersRepository.findForSessionSync>>;
  try {
    row = await usersRepository.findForSessionSync(userId);
  } catch (error) {
    log.error('Live platform-capability check failed — denying', {
      actorUserId: userId,
      capability,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }
  if (row === null || row.deletedAt !== null || row.status !== 'active') return false;
  // `sealedPlatformCapabilities` is the ONE encoder — absent when the column is NULL — so this
  // actor is shaped exactly like a sealed `SessionUser` and resolves through the same seam.
  return hasPlatformCapability(
    { platformRole: row.platformRole, ...sealedPlatformCapabilities(row) },
    capability
  );
}
