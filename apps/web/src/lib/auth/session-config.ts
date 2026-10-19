/**
 * Session cookie configuration shared between server code and Edge middleware.
 * NO 'server-only' import — must be importable from middleware (Edge Runtime).
 */

export const COOKIE_NAME = 'balo_session';

/**
 * 90 days — matches the WorkOS AuthKit application's maximum session length (dashboard →
 * Applications → Sessions; inactivity timeout 30 days). The cookie must not die before the WorkOS
 * session does, or a user WorkOS still considers signed in is sent to /login. The reverse — WorkOS
 * ending first — is handled by middleware, which destroys the cookie on WorkOS's "session has
 * already ended" refresh answer. Change both together.
 *
 * Every refresh re-seals the cookie, so for an active user it slides; the WorkOS maximum is the
 * hard bound.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

/**
 * `ttl` AND `cookieOptions.maxAge` are both set, to the same value: iron-session derives `maxAge`
 * from `ttl` only when `maxAge` is absent, and without `ttl` the SEAL keeps iron-session's 14-day
 * default — a 90-day cookie would then stop unsealing after two weeks.
 */
export const sessionConfig = {
  password: process.env.WORKOS_COOKIE_PASSWORD!,
  cookieName: COOKIE_NAME,
  ttl: SESSION_MAX_AGE_SECONDS,
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
};

/**
 * BAL-553 — an impersonated session lives 30 minutes, absolute. Never the 90-day cookie.
 *
 * DOCUMENT-ONLY (fix round 1, security agent informational) — `iron-webcrypto` (via
 * `iron-session`) applies a FIXED 60-second clock-skew allowance on top of whatever `ttl` a seal
 * is sealed with before it is treated as expired (the same behaviour
 * `lib/workspaces/switch-token.ts` documents and pins in its own tests). The EFFECTIVE window for
 * an impersonated seal is therefore ~31 minutes, not exactly 30 — read this constant as the
 * INTENDED duration, not the hard outer bound.
 */
export const IMPERSONATED_SESSION_MAX_AGE_SECONDS = 60 * 30;

/**
 * A per-save config override for an impersonated session — a NEW object every call. The shared
 * `sessionConfig` literal above is never mutated: it is imported by Edge middleware and by every
 * normal session save, so mutating it would shorten everyone's cookie (ruling R5).
 *
 * ⚠⚠ BOTH `ttl` AND `cookieOptions.maxAge` ARE SET, AND BOTH ARE LOAD-BEARING. iron-session
 * derives `maxAge` from `ttl` ONLY when `cookieOptions` carries no `maxAge` key — which
 * `sessionConfig` above DOES carry — so setting `maxAge` alone here would leave the SEAL at
 * iron-session's 14-day default while the cookie expires in 30 minutes. A copied cookie value
 * would then still unseal for two weeks. The seal ttl is the real boundary: iron embeds an
 * absolute `exp` at seal time and `unsealData` returns `{}` (no session) once it passes,
 * whatever config the reader uses.
 *
 * `remainingSeconds` is clamped to `[1, IMPERSONATED_SESSION_MAX_AGE_SECONDS]` so re-saving can
 * never EXTEND the window past its original 30-minute deadline (the caller passes the time left
 * until the session's absolute `impersonationExpiresAt`, not a fresh 30 minutes).
 */
export function impersonatedSessionConfig(
  remainingSeconds: number
): typeof sessionConfig & { ttl: number } {
  const ttl = Math.min(
    Math.max(Math.ceil(remainingSeconds), 1),
    IMPERSONATED_SESSION_MAX_AGE_SECONDS
  );
  return {
    ...sessionConfig,
    ttl,
    cookieOptions: { ...sessionConfig.cookieOptions, maxAge: ttl },
  };
}
