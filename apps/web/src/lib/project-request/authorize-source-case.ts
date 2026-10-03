import 'server-only';

import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
// lib→app import, same precedent as `lib/meetings/is-terminal-proposal-failure.ts` (imports
// `case-action-types` from the app tree). The case gate lives beside its sibling case actions;
// re-declaring it here would be a second definition of the client-lens membership gate.
import { authorizeClientCaseMutation } from '@/app/(dashboard)/cases/[engagementId]/_lib/authorize-client-case-mutation';

/** What a request converted from a case carries forward — the notification + the done-step link. */
export interface SourceCaseInfo {
  id: string;
  title: string;
}

export type AuthorizeSourceCaseResult =
  | { ok: true; sourceCase: SourceCaseInfo | null }
  | { ok: false; error: string };

/**
 * BAL-589 — re-authorize a submit's `sourceCaseId` against the SESSION, exactly like
 * every other input `submitProjectRequestAction` checks: the client's own rendering gate
 * is never trusted as the real one. Extracted out of the action (SonarCloud
 * cognitive-complexity gate) so the action's own control flow stays flat.
 *
 * A `sourceCaseId` of `undefined` is the ordinary (non-conversion) path and short-circuits to
 * `{ ok: true, sourceCase: null }` without touching the case gate at all.
 *
 * Checks, in order:
 *   1. `authorizeClientCaseMutation` — the shared client-lens membership gate (onboarded
 *      session already established by the caller, tenancy re-run, `lens === 'client'`,
 *      `PARTICIPATE`).
 *   2. The gate's `companyId` (from the LOADED case row) must equal the session's ACTIVE
 *      company.
 *   3. For a `direct` submit, the case's own expert must equal the request's target expert
 *      — a case cannot be converted into a direct request to a DIFFERENT expert. A
 *      `match` submit skips this check (the "Get matched instead" fallback still carries
 *      provenance).
 */
export async function authorizeSourceCase(params: {
  sourceCaseId: string | undefined;
  sendTo: 'direct' | 'match';
  directExpertProfileId: string | null;
  user: SessionUser;
}): Promise<AuthorizeSourceCaseResult> {
  const { sourceCaseId, sendTo, directExpertProfileId, user } = params;
  if (sourceCaseId === undefined) {
    return { ok: true, sourceCase: null };
  }

  const gate = await authorizeClientCaseMutation(
    sourceCaseId,
    user,
    "You don't have permission to convert this case."
  );
  if (!gate.ok) {
    log.warn('Project request rejected — case gate denied', {
      userId: user.id,
      sourceCaseId,
      error: gate.error,
    });
    return { ok: false, error: gate.error };
  }

  if (gate.companyId !== user.companyId) {
    log.warn('Project request rejected — active company does not match the case', {
      userId: user.id,
      sourceCaseId,
    });
    return { ok: false, error: 'Switch to the workspace this case belongs to.' };
  }

  if (sendTo === 'direct' && gate.expertProfileId !== directExpertProfileId) {
    log.warn('Project request rejected — case expert does not match the direct target', {
      userId: user.id,
      sourceCaseId,
    });
    return { ok: false, error: "This case isn't with that expert." };
  }

  return { ok: true, sourceCase: { id: sourceCaseId, title: gate.caseRow.title } };
}
