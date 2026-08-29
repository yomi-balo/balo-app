import 'server-only';

import type { DerivedWorkspaces } from '@balo/shared/workspaces';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-494 — the ONE place a `SessionUser` is patched from a workspace derivation. Every
 * writer (OAuth callback, session-sync route, switch service) goes through this so there is
 * no drift between them and no duplicated projection logic (Sonar new-code duplication gate).
 *
 * Mutates `user` IN PLACE and does NOT call `session.save()` — the caller owns the session
 * lifecycle (some callers still have more fields to patch, or a DB write to sequence first).
 *
 * ⚠ WRITES THE POINTER (`activeWorkspace`) AND THE PROJECTION — NEVER THE LIST.
 * `derived.workspaces` is deliberately dropped on the floor here: the sealed cookie has a hard
 * 4096-byte browser limit and a list of five to eight company workspaces overruns it, at which
 * point the browser silently discards the `Set-Cookie` and the user is locked out with no
 * server-side error (security fix round 2; see `SessionUser`'s docblock, and
 * `lib/auth/session-cookie-size.test.ts` for the measured budget). The list is re-derived
 * server-side on every request anyway — `getWorkspacesForCurrentUser()` is its accessor.
 */
export function applyWorkspaceDerivationToSessionUser(
  user: SessionUser,
  derived: DerivedWorkspaces
): void {
  user.activeWorkspace = derived.activeWorkspace;
  user.activeMode = derived.session.activeMode;
  user.companyId = derived.session.companyId;
  user.companyName = derived.session.companyName;
  user.companyRole = derived.session.companyRole;
}

/** `undefined` for a pre-BAL-494 cookie that carries no workspace. */
export function activeWorkspaceKeyOf(user: SessionUser): string | undefined {
  return user.activeWorkspace?.key;
}
