import { NextRequest, NextResponse } from 'next/server';
import { usersRepository } from '@balo/db';
import { deriveWorkspaces, type StoredWorkspaceChoice } from '@balo/shared/workspaces';
import { getSession } from '@/lib/auth/session';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import { loadWorkspaceDerivationMaterials } from '@/lib/workspaces/derive-workspaces';
import { applyWorkspaceDerivationToSessionUser } from '@/lib/workspaces/session-workspace';
import { log } from '@/lib/logging';

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
    const hasExpertWorkspace = derived.workspaces.some((w) => w.type === 'expert');
    const needsRepair = dbUser.activeMode === 'expert' && !hasExpertWorkspace;

    // Narrow repair write — the ONLY DB write this route performs. If the DB still says
    // `activeMode: 'expert'` but the derivation finds no expert workspace (e.g. the user's
    // approval was revoked), demote it in the DB. Without this, the drift check's
    // `activeMode` comparison would see the session say 'expert' (matching the stale DB)
    // forever, and the projection invariant would fight it on every request → an infinite
    // redirect loop.
    //
    // ADR-1030 — DELIBERATELY NOT AUDITED, same ruling as the switch write in
    // `lib/workspaces/switch-workspace.ts` (see the full rationale there). Additionally, this
    // write is a SYSTEM-INITIATED CONSEQUENCE, not an actor's act: it is the derivation
    // reconciling stale state after the expert profile lost approval, and THAT event is the
    // auditable one, at its own source. Auditing the echo here would attribute a state change
    // to whichever user happened to trigger the next page render. The `log.info` below is the
    // correct home for it per ADR-1030's Pino/Axiom split.
    if (needsRepair) {
      await usersRepository.update(session.user.id, { activeMode: 'client' });
      log.info('Workspace repair: activeMode demoted to client', { userId: session.user.id });
    }

    // Recompute PURELY from the same materials with the repaired stored choice — no second
    // DB read, and no stale-cache risk (we never call the cache()'d wrapper twice).
    const finalStored: StoredWorkspaceChoice = needsRepair
      ? { activeMode: 'client', activeCompanyId: materials.stored.activeCompanyId }
      : materials.stored;
    const finalDerived = needsRepair ? deriveWorkspaces(materials.input, finalStored) : derived;
    if (finalDerived !== null) {
      applyWorkspaceDerivationToSessionUser(session.user, finalDerived);
    }
  }
  // `derived === null` (no company at all) → leave the workspace fields absent; the layout
  // then behaves exactly as today. A stale `active_company_id` is NOT cleared here — it is
  // never trusted without revalidation (see `deriveWorkspaces`'s fallback rule) and retaining
  // it restores the user's choice if they rejoin the company.

  await session.save();

  log.info('Session synced: drift detected and patched', {
    userId: session.user.id,
  });

  return NextResponse.redirect(new URL(safeReturnTo, request.url));
}
