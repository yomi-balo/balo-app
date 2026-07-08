'use server';

import 'server-only';

import { usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { resolveExpertAgency } from '@/lib/expert-agency/resolve-expert-agency';
import type { ResolveExpertAgencyResult } from '@/lib/expert-agency/types';
import { log } from '@/lib/logging';

export type { ResolveExpertAgencyResult } from '@/lib/expert-agency/types';

/**
 * BAL-356 / ADR-1034 — READ-ONLY, authenticated Server Action that resolves the
 * signed-in expert's determined agency outcome from their VERIFIED signup email.
 * Mirrors `resolveOnboardingCompanyAction`: uses `getSession()` directly — NOT
 * `requireUser()` (which throws on a missing user) — and performs ZERO writes.
 *
 * The email AND its verified flag are sourced from the persisted `users` row (DB is
 * authoritative — never a client arg, and never the session's possibly-stale copy) so
 * the ADR-1034 verified-email gate in the pure resolver reflects the real, in-sync
 * verification state.
 *
 * FAIL-OPEN: no session/user, or any thrown error → `{ kind: 'solo' }` so signup is
 * never blocked on a resolve failure (the independent path is the safe default). The
 * authoritative write re-resolves, so a stale/optimistic `solo` here is corrected at
 * Continue time.
 */
export async function resolveExpertAgencyAction(): Promise<ResolveExpertAgencyResult> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { kind: 'solo' }; // no auth → fail open to the independent path

  try {
    // DB is authoritative for email + verification state (never trust the session copy).
    const dbUser = await usersRepository.findById(userId);
    if (dbUser === undefined) return { kind: 'solo' }; // no user row → fail open
    return await resolveExpertAgency(dbUser.email, dbUser.emailVerified);
  } catch (error) {
    log.warn('Expert agency resolve failed (failing open to solo)', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'solo' }; // fail OPEN — never block signup on a resolve failure
  }
}
