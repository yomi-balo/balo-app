import 'server-only';

import { getSession, type SessionUser } from './session';
import { isPlatformAdmin } from './is-admin';

/**
 * Resolve the current admin session user, or throw `'Unauthorized'` / `'Forbidden'`.
 *
 * Mirrors the inline `platformRole` guard in `approve-expert.ts` (the in-repo
 * precedent — there is no `withAdminAuth` wrapper in apps/web). Use at the top of
 * every admin Server Action. Returns the {@link SessionUser} so callers get
 * `user.id` for attribution (e.g. `invitedByUserId`).
 *
 * Unlike `approve-expert.ts`, A2's admin queue is a real product surface — it is
 * NOT gated to non-production.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  if (!isPlatformAdmin(session.user)) {
    throw new Error('Forbidden');
  }
  return session.user;
}
