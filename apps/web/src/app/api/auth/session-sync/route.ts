import { NextRequest, NextResponse } from 'next/server';
import { usersRepository } from '@balo/db';
import {
  deriveWorkspaces,
  type DerivedWorkspaces,
  type StoredWorkspaceChoice,
} from '@balo/shared/workspaces';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { platformRoleIsStaff } from '@balo/shared/authz';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import {
  loadWorkspaceDerivationMaterials,
  type WorkspaceDerivationMaterials,
} from '@/lib/workspaces/derive-workspaces';
import { applyWorkspaceDerivationToSessionUser } from '@/lib/workspaces/session-workspace';
import { log } from '@/lib/logging';

type SessionSyncDbUser = NonNullable<
  Awaited<ReturnType<typeof usersRepository.findForSessionSync>>
>;

/**
 * BAL-553 / cognitive-complexity extraction — the drift-repair block used to live inline in
 * `GET`, which pushed the route handler over SonarCloud's complexity budget. Pulled out so the
 * handler's own branching stays simple; this function is scored separately by the linter.
 *
 * Narrow repair write — the ONLY DB write this route performs. If the DB still says
 * `activeMode: 'expert'` but the derivation finds no expert workspace (e.g. the user's
 * approval was revoked), demote it in the DB. Without this, the drift check's `activeMode`
 * comparison would see the session say 'expert' (matching the stale DB) forever, and the
 * projection invariant would fight it on every request → an infinite redirect loop.
 *
 * ADR-1030 — DELIBERATELY NOT AUDITED, same ruling as the switch write in
 * `lib/workspaces/switch-workspace.ts` (see the full rationale there). Additionally, this
 * write is a SYSTEM-INITIATED CONSEQUENCE, not an actor's act: it is the derivation
 * reconciling stale state after the expert profile lost approval, and THAT event is the
 * auditable one, at its own source. Auditing the echo here would attribute a state change to
 * whichever user happened to trigger the next page render. The `log.info` below is the
 * correct home for it per ADR-1030's Pino/Axiom split.
 */
async function reconcileWorkspaceDrift(
  user: SessionUser,
  dbUser: SessionSyncDbUser,
  materials: WorkspaceDerivationMaterials,
  derived: DerivedWorkspaces
): Promise<void> {
  const hasExpertWorkspace = derived.workspaces.some((w) => w.type === 'expert');
  const needsRepair = dbUser.activeMode === 'expert' && !hasExpertWorkspace;

  if (needsRepair) {
    await usersRepository.update(user.id, { activeMode: 'client' });
    log.info('Workspace repair: activeMode demoted to client', {
      userId: user.id,
      // BAL-553 — the write targets the IMPERSONATED user's row while a staff member drives
      // it; conditional spread (the `actorImpersonating` metadata precedent) keeps a normal
      // session's log line byte-identical to before.
      ...(user.impersonatorUserId === undefined
        ? {}
        : { impersonatorUserId: user.impersonatorUserId }),
    });
  }

  // Recompute PURELY from the same materials with the repaired stored choice — no second
  // DB read, and no stale-cache risk (we never call the cache()'d wrapper twice).
  const finalStored: StoredWorkspaceChoice = needsRepair
    ? { activeMode: 'client', activeCompanyId: materials.stored.activeCompanyId }
    : materials.stored;
  const finalDerived = needsRepair ? deriveWorkspaces(materials.input, finalStored) : derived;
  if (finalDerived !== null) {
    applyWorkspaceDerivationToSessionUser(user, finalDerived);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  const returnTo = request.nextUrl.searchParams.get('returnTo');
  const safeReturnTo = getSafeRedirectPath(returnTo, request.url);

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const dbUser = await usersRepository.findForSessionSync(session.user.id);

  if (!dbUser) {
    log.warn('Session sync: user not found in DB, destroying session', {
      userId: session.user.id,
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_deleted', request.url));
  }

  if (dbUser.deletedAt !== null) {
    log.info('Session invalidated: user deleted', {
      userId: session.user.id,
      reason: 'deleted',
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_deleted', request.url));
  }

  if (dbUser.status !== 'active') {
    log.info('Session invalidated: user suspended', {
      userId: session.user.id,
      reason: 'suspended',
      status: dbUser.status,
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_suspended', request.url));
  }

  // BAL-553 fix round 2, F3 — a SECOND super_admin promoting the impersonation TARGET to staff
  // while the impersonation is live must not hand the impersonated session `/admin` (and every
  // `hasPlatformCapability` gate) while `isImpersonating` stays true — exactly the attribution-
  // laundering case the staff-target refusal at start exists to prevent. Not a privilege
  // escalation beyond what the impersonator already holds (session chaining is refused
  // unconditionally at start), but it must fail closed rather than silently copy the promotion
  // onto a session still flagged as impersonated.
  if (isImpersonatedSession(session.user) && platformRoleIsStaff(dbUser.platformRole)) {
    log.warn('Session invalidated: impersonation target promoted to staff mid-session', {
      userId: session.user.id,
      impersonatorUserId: session.user.impersonatorUserId,
      newPlatformRole: dbUser.platformRole,
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=session_expired', request.url));
  }

  // Patch session with fresh DB values
  session.user.activeMode = dbUser.activeMode;
  session.user.platformRole = dbUser.platformRole;
  session.user.onboardingCompleted = dbUser.onboardingCompleted;
  session.user.expertProfileId = dbUser.expertProfileId ?? undefined;

  // BAL-494 / ADR-1053 — the read half only (NOT `deriveWorkspacesForUser`, which is React
  // `cache()`'d: a second call in this same request would replay the PRE-repair memoized
  // result instead of reflecting the DB write below). `loadWorkspaceDerivationMaterials` is
  // ALSO cache()'d, but that is fine here — this is its first (and only) call this request.
  const materials = await loadWorkspaceDerivationMaterials(session.user.id);
  const derived = deriveWorkspaces(materials.input, materials.stored);
  if (derived !== null) {
    await reconcileWorkspaceDrift(session.user, dbUser, materials, derived);
  }
  // `derived === null` (no company at all) → leave the workspace fields absent; the layout
  // then behaves exactly as today. A stale `active_company_id` is NOT cleared here — it is
  // never trusted without revalidation (see `deriveWorkspaces`'s fallback rule) and retaining
  // it restores the user's choice if they rejoin the company.

  await session.save();

  log.info('Session synced: drift detected and patched', {
    userId: session.user.id,
    ...(session.user.impersonatorUserId === undefined
      ? {}
      : { impersonatorUserId: session.user.impersonatorUserId }),
  });

  return NextResponse.redirect(new URL(safeReturnTo, request.url));
}
