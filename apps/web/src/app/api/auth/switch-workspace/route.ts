import { NextRequest, NextResponse } from 'next/server';
import { switchWorkspace } from '@/lib/workspaces/switch-workspace';
import {
  unsealWorkspaceSwitchToken,
  WORKSPACE_SWITCH_TOKEN_PARAM,
} from '@/lib/workspaces/switch-token';
import { getSession } from '@/lib/auth/session';
import { accountRefusalFor, ACCOUNT_UNREADABLE } from '@/lib/auth/account-liveness';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import { log } from '@/lib/logging';

/**
 * BAL-494 — the deep-link auto-switch Route Handler.
 * `GET /api/auth/switch-workspace?t=<sealed token>&returnTo=<same-origin path>`
 *
 * GET (not POST) is forced by the mechanism: the only way to persist a switch mid-render is
 * `redirect()` from an RSC, which issues a browser GET. Precedent:
 * `api/auth/session-sync/route.ts` is already a mutating GET.
 *
 * ⚠ CSRF + CROSS-SITE. This route is authorized by a SHORT-TTL SEALED TOKEN, minted by the
 * page that decided to auto-switch (`projects/[requestId]/page.tsx`). It deliberately does
 * NOT look at `Sec-Fetch-Site`: that header is computed over the request's entire url list
 * against the INITIATOR's origin and is never recomputed per hop, so a link clicked in Gmail
 * or Slack web stays `cross-site` across our own same-origin redirect — a `cross-site`
 * rejection therefore looped every multi-workspace user to `ERR_TOO_MANY_REDIRECTS`.
 *
 * The token SUPERSEDES that header and additionally covers requests it did not: an attacker
 * cannot mint one, and it binds the user AND the target AND the return path, so it rejects
 * same-site requests and `Sec-Fetch-Site: none` requests (typed URLs, bookmarks, native mail
 * clients) that the header would have allowed. It is NOT a strict superset — the header
 * uniquely blocked a cross-site replay of an already-captured LIVE token — and
 * `lib/workspaces/switch-token.ts` records why `sameSite: 'lax'` makes that residual
 * acceptable, along with the replay and domain-separation analysis.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // The clear-text `returnTo` is only ever a REDIRECT TARGET (always through the open-redirect
  // guard) — never a switch input. The switch reads the sealed payload exclusively.
  const rawReturnTo = request.nextUrl.searchParams.get('returnTo');
  const fallbackReturnTo = getSafeRedirectPath(rawReturnTo, request.url);

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // ⚠⚠ BAL-568 (fix round 1, F1) — ACCOUNT LIVENESS, AND THIS ROUTE IS WHY THE GATE CANNOT LIVE
  // ONLY ON THE SERVER-ACTION SEAMS. This handler resolves its actor with a raw `getSession()`,
  // then `switchWorkspace(…)` below WRITES to `users` and calls `session.save()`, **re-sealing a
  // fresh seven-day cookie**. A suspended account holding a pending deep-link token therefore both
  // acted and had its cookie renewed — a live counterexample to this ticket's headline property,
  // found by the security gate rather than by the invariant, because that invariant walks
  // `'use server'` modules and a Route Handler is not one. (`route-handler-liveness-gate.test.ts`
  // now closes that corpus gap.)
  //
  // ⚠ A CONFIRMED REFUSAL REDIRECTS TO THE SYNC ROUTE, NOT TO `/login` DIRECTLY. The sync Route
  // Handler re-reads the live row, destroys the cookie and lands on
  // `/login?error=account_suspended|account_deleted` with BAL-197's shipped copy; a bare `/login`
  // would lose the message entirely. Same move as `signOutOnAccountRefusal` in
  // `components/balo/phone-verification-flow.tsx`.
  //
  // ⚠⚠ "COULD NOT TELL" IS NOT "NOT LIVE" (fix round 2, G5). An unreadable row still REFUSES — the
  // switch does not happen either way — but sending a DB fault down the sign-out path was both
  // dishonest and useless: the sync route would read the same unreachable database and 500. A 503
  // says what actually happened, keeps the person's session intact so a retry works once the
  // database is back, and is the correct status for a transient dependency failure.
  //
  // ⚠ IT IS LOG-ONLY (fix round 2, G3): `{ path: 'page' }` with no `emit`. The sync route this
  // redirects to owns the `page` emission, and emitting here too would double-count one ejection.
  const refusal = await accountRefusalFor(session.user.id, { path: 'page' });
  if (refusal === ACCOUNT_UNREADABLE) {
    log.error('Workspace switch (deep link) refused: liveness read failed', {
      userId: session.user.id,
    });
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  if (refusal !== null) {
    return NextResponse.redirect(new URL('/api/auth/session-sync?returnTo=/login', request.url));
  }

  if (session.user.onboardingCompleted !== true) {
    return NextResponse.redirect(new URL('/onboarding', request.url));
  }

  const token = await unsealWorkspaceSwitchToken(
    request.nextUrl.searchParams.get(WORKSPACE_SWITCH_TOKEN_PARAM)
  );
  if (token === null) {
    // Missing, malformed, tampered or expired. An expired token is the common case (the user
    // sat on the redirect); redirecting back to the page re-mints a fresh one, so this
    // self-heals in one extra hop and cannot loop.
    log.warn('Workspace switch rejected: missing or invalid token', { userId: session.user.id });
    return NextResponse.redirect(new URL(fallbackReturnTo, request.url));
  }

  if (token.userId !== session.user.id) {
    log.warn('Workspace switch rejected: token minted for a different user', {
      userId: session.user.id,
    });
    return NextResponse.redirect(new URL(fallbackReturnTo, request.url));
  }

  if (token.returnTo !== rawReturnTo) {
    log.warn('Workspace switch rejected: returnTo does not match the sealed token', {
      userId: session.user.id,
    });
    return NextResponse.redirect(new URL(fallbackReturnTo, request.url));
  }

  // Defence in depth — the sealed value is server-built, but it is still re-validated.
  const safeReturnTo = getSafeRedirectPath(token.returnTo, request.url);

  try {
    const result = await switchWorkspace(session.user, token.targetKey, 'deep_link_auto');
    if (!result.ok) {
      // A race (membership removed between mint and redeem), not an attack. Returning to the
      // deep link is safe HERE and only here: `switchWorkspace` rejected on a REREAD of the
      // actor's derived list, so the page re-resolves against the same rejected state and
      // renders its normal not-found path rather than re-minting.
      log.warn('Workspace switch (deep link) rejected', {
        userId: session.user.id,
        reason: result.reason,
      });
    }
    return NextResponse.redirect(new URL(safeReturnTo, request.url));
  } catch (error) {
    // ⚠ THIS ARM MUST NOT RETURN TO THE DEEP LINK. A DB failure must not 500 a navigation,
    // but it must not loop either: the page's reads can still succeed while
    // `usersRepository.update` keeps failing, so it would re-resolve, re-mint a fresh token
    // and send the user straight back here — unbounded for as long as the write path is down.
    // (The `!result.ok` arms above are different: those rejected on a read that the page
    // repeats, so they converge.) `/dashboard` is a fixed, always-valid landing that mints no
    // switch token, which terminates the cycle in one hop.
    log.error('Workspace switch (deep link) failed', {
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
}
