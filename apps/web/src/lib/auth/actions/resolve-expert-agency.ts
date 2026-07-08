'use server';

import 'server-only';

import { getSession } from '@/lib/auth/session';
import { resolveExpertAgency } from '@/lib/expert-agency/resolve-expert-agency';
import type { ResolveExpertAgencyResult } from '@/lib/expert-agency/types';
import { log } from '@/lib/logging';

export type { ResolveExpertAgencyResult } from '@/lib/expert-agency/types';

/**
 * BAL-356 / ADR-1034 — READ-ONLY, authenticated Server Action that resolves the
 * signed-in expert's determined agency outcome from their verified signup email
 * domain. Mirrors `resolveOnboardingCompanyAction`: reads the email from the SESSION
 * (never a client arg), uses `getSession()` directly — NOT `requireUser()` (which
 * throws on a missing user) — and performs ZERO writes.
 *
 * FAIL-OPEN: no session/email, or any thrown error → `{ kind: 'solo' }` so signup is
 * never blocked on a resolve failure (the independent path is the safe default). The
 * authoritative write re-resolves, so a stale/optimistic `solo` here is corrected at
 * Continue time.
 */
export async function resolveExpertAgencyAction(): Promise<ResolveExpertAgencyResult> {
  const session = await getSession();
  const email = session?.user?.email;
  if (!email) return { kind: 'solo' }; // no auth/email → fail open to the independent path

  try {
    return await resolveExpertAgency(email);
  } catch (error) {
    log.warn('Expert agency resolve failed (failing open to solo)', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'solo' }; // fail OPEN — never block signup on a resolve failure
  }
}
