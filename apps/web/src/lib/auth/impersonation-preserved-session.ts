import 'server-only';

import { sealData, unsealData } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionConfig, IMPERSONATED_SESSION_MAX_AGE_SECONDS } from './session-config';
import { log } from '@/lib/logging';
import type { SessionData } from './session';

/**
 * BAL-553 ⟦R6⟧ — the sealed preserved-admin-session primitive. `startImpersonationAction` seals
 * the STAFF member's own `SessionData` (user + WorkOS tokens) into this cookie before swapping the
 * live `balo_session` cookie to the target; `stopImpersonationAction` reads it back to restore.
 *
 * ⚠ SEALED, NOT `JSON.stringify` (the workos-auth skill sketch's shape). That object carries the
 * admin's WorkOS `accessToken`/`refreshToken` — shipping those in plaintext to the browser is not
 * acceptable at any TTL. Sealed with iron-session, the SAME password as `balo_session` (one secret
 * to rotate — the `lib/workspaces/switch-token.ts` precedent), `ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS`.
 *
 * ⚠ THE PRESERVED COOKIE DOES NOT OUTLIVE THE IMPERSONATION WINDOW. A preserved admin session that
 * survived longer would be a standing credential sitting in the browser after the impersonation it
 * belonged to had ended. If the staff member never presses stop, both cookies expire together and
 * they sign in again — the correct, fail-closed outcome.
 *
 * ⚠ DOMAIN SEPARATION (fix round 1, S2) — this seal shares ONE password with `balo_session`
 * (deliberately — one secret to rotate). `balo_session`'s own payload is structurally
 * `{ user, accessToken, refreshToken }` — the SAME shape this seal carries — so a `balo_session`
 * value pasted into `balo_admin_session` would otherwise pass the `user.id` shape check below.
 * Not exploitable today (reaching the unseal requires an already-impersonated session, which
 * only this server mints), but the only thing preventing it was a shape coincidence. Follows
 * `lib/workspaces/switch-token.ts`'s existing pattern exactly: a `purpose` discriminator, sealed
 * alongside the payload and asserted FIRST on unseal, before any other check.
 */
export const PRESERVED_ADMIN_COOKIE = 'balo_admin_session';

/**
 * The seal's domain-separation discriminator. Exported so `impersonation-preserved-session.test.ts`
 * cannot drift from the literal this module asserts on.
 */
export const IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE = 'impersonation_preserved_admin';

/** Seal the staff member's own session for later restoration. TTL is the impersonation window. */
export async function sealPreservedAdminSession(data: SessionData): Promise<string> {
  return sealData(
    {
      // Not part of `SessionData`: callers must not be able to choose it, and no caller has
      // anything to say about it. It exists on the WIRE only.
      purpose: IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE,
      user: data.user,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    },
    { password: sessionConfig.password, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
  );
}

/**
 * `null` for a missing, malformed, tampered, wrong-password, WRONG-PURPOSE or EXPIRED seal:
 * `unsealData` yields `{}` for expiry / bad hmac / unknown password (it does not throw), so the
 * checks below are what actually reject those, and they convert every failure mode into one
 * honest `null`.
 */
export async function unsealPreservedAdminSession(seal: string): Promise<SessionData | null> {
  try {
    const data = await unsealData<Partial<SessionData> & { purpose?: unknown }>(seal, {
      password: sessionConfig.password,
      ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS,
    });

    // Checked FIRST — see the module docblock's domain-separation note. A seal minted for
    // another purpose with the shared session password is rejected on the discriminator, not
    // incidentally on a field it happens not to carry.
    if (data.purpose !== IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE) return null;

    if (data.user === undefined || typeof data.user.id !== 'string' || data.user.id === '') {
      return null;
    }

    return {
      user: data.user,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };
  } catch (error) {
    // A structurally invalid seal makes iron-session throw before it can return `{}`. Treated
    // exactly like expiry — the caller destroys the impersonated session and refuses to restore.
    log.warn('Preserved admin session could not be unsealed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Cookie options mirror `sessionConfig.cookieOptions` (httpOnly / secure / sameSite) with the
 * impersonation-window `maxAge` — this cookie's lifetime IS the impersonation window, by design.
 */
export async function writePreservedAdminCookie(seal: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(PRESERVED_ADMIN_COOKIE, seal, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: IMPERSONATED_SESSION_MAX_AGE_SECONDS,
  });
}

export async function readPreservedAdminCookie(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(PRESERVED_ADMIN_COOKIE)?.value;
}

export async function clearPreservedAdminCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(PRESERVED_ADMIN_COOKIE);
}
