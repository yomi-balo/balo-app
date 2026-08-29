import 'server-only';

import { cache } from 'react';
import type { Workspace } from '@balo/shared/workspaces';
import { getCurrentUser } from '@/lib/auth/session';
import { deriveWorkspacesForUser } from './derive-workspaces';

/**
 * BAL-494 — the server-side accessor for the actor's FULL workspace list, and the seam
 * BAL-496's switcher renders from.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN A COOKIE FIELD. The list was originally sealed into
 * `balo_session` as `SessionUser.workspaces`. That is an unbounded lockout: a browser SILENTLY
 * DISCARDS a `Set-Cookie` over 4096 bytes, and the sealed cookie crosses that at five to eight
 * company workspaces (see `lib/auth/session-cookie-size.test.ts` for the measurement) — so
 * such a user would sign in, lose the cookie, be bounced to `/login`, and repeat forever with
 * no server-side error. Capping or truncating is forbidden (orchestrator ruling R2: it would
 * hide a workspace the user legitimately holds). Deriving on demand has no such ceiling.
 *
 * ⚠ AND IT COSTS NOTHING. `checkSessionDrift` already calls `deriveWorkspacesForUser` on every
 * page render (the accepted R4 cost) and that function is React-`cache()`d per request, so on
 * any authenticated page this call replays a memoized derivation rather than issuing reads.
 * The extra `cache()` here dedupes the session read for multiple callers in one request tree.
 *
 * Returns an EMPTY list — never throws — when there is no session user or when the actor has
 * no derivable workspace at all (`deriveWorkspaces` returns `null` for a user with zero live
 * company memberships). A switcher with nothing to switch to renders nothing; that is a
 * stable, correct state, not an error (see `checkSessionDrift`'s bootstrap arm, which relies
 * on the same fact to avoid an infinite sync loop).
 *
 * ⚠ NOT AN AUTHORIZATION SEAM. This answers "what may this actor act as", for PRESENTATION.
 * The authorization inputs stay exactly where they were: `hasCapability` for membership,
 * and `session.companyId` — the projection of `activeWorkspace` — for the client lens.
 */
export const getWorkspacesForCurrentUser = cache(async (): Promise<readonly Workspace[]> => {
  const user = await getCurrentUser();
  if (user === null) return [];

  const derived = await deriveWorkspacesForUser(user.id);
  return derived?.workspaces ?? [];
});
