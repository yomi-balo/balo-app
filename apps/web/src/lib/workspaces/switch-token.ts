import 'server-only';

import { sealData, unsealData } from 'iron-session';
import { sessionConfig } from '@/lib/auth/session-config';
import { log } from '@/lib/logging';

/**
 * BAL-494 — the short-TTL sealed token that authorizes ONE deep-link auto-switch.
 *
 * ⚠ WHY A TOKEN AND NOT `Sec-Fetch-Site`. The header is computed over the request's ENTIRE
 * url list against the INITIATOR's origin — it is NOT recomputed per hop. A `/projects/<id>`
 * link clicked from Gmail/Slack web arrives `cross-site` and STAYS `cross-site` across our
 * own same-origin redirect into this route, so a `cross-site` rejection bounced every
 * multi-workspace user between page → switch → page → … until `ERR_TOO_MANY_REDIRECTS`.
 * (Native mail clients send `Sec-Fetch-Site: none`, which is why manual testing missed it.)
 *
 * The sealed token SUPERSEDES that header, and additionally covers requests the header did
 * not: an attacker cannot mint one (it is sealed with the session password), and it binds the
 * user AND the target AND the return path — so it rejects SAME-SITE requests (a subdomain or
 * a stored-XSS payload on our own origin, which `Sec-Fetch-Site: same-site` would have waved
 * through), rejects `Sec-Fetch-Site: none` requests (typed URLs, bookmarks, native mail
 * clients), and works at all in header-less browsers, where the check could only fail open or
 * lock everyone out.
 *
 * ⚠ IT IS NOT A STRICT SUPERSET, and the one sliver matters enough to write down. The header
 * uniquely blocked a CROSS-SITE REPLAY OF AN ALREADY-CAPTURED LIVE TOKEN — a `<img>` or
 * `<iframe>` on attacker.com pointing at a URL the attacker somehow read out of the victim's
 * history/referrer inside the TTL. That residual is acceptable because `balo_session` is
 * `sameSite: 'lax'` (`lib/auth/session-config.ts`): the session cookie is NOT sent on a
 * cross-site sub-resource request, so any such replay must be a TOP-LEVEL NAVIGATION the
 * victim can see happening, not a silent background hit — and see the replay analysis below
 * for why even a successful one gains nothing.
 *
 * ⚠ REPLAY. TTL-bounding is the replay control; this token is NOT single-use — true
 * single-use would need server-side storage (a table or Redis) for the window. The impact is
 * bounded by construction: the sealed `targetKey` must already be in the victim's OWN
 * server-derived workspace list (`switchWorkspace` re-validates set membership on every
 * call), so a replay can only re-select a workspace the victim already holds. The worst
 * outcome is a repeated context flip inside the window, never a privilege gain.
 *
 * ⚠ THE REPLAY WINDOW IS 120 SECONDS, NOT 60 — see
 * {@link WORKSPACE_SWITCH_TOKEN_TTL_SECONDS}.
 *
 * ⚠ DOMAIN SEPARATION. The seal shares ONE secret with the session cookie
 * (`WORKOS_COOKIE_PASSWORD`) — deliberately, so there is one key to rotate — so the payload
 * carries an explicit {@link WORKSPACE_SWITCH_TOKEN_PURPOSE} discriminator that `unseal`
 * asserts. Neither confusion direction was exploitable without it (each seal is rejected by
 * the other's shape checks), but that was an EMERGENT property of two shapes happening not to
 * overlap; the discriminator states it instead.
 */
export interface WorkspaceSwitchToken {
  /** The user the token was minted FOR. The route rejects a mismatch against the session. */
  readonly userId: string;
  /** `Workspace['key']` — the switch target. Never read from a raw query param. */
  readonly targetKey: string;
  /** The server-built path to return to. Still run through `getSafeRedirectPath`. */
  readonly returnTo: string;
}

/**
 * Seconds. Long enough for a redirect round trip, short enough to bound replay.
 *
 * ⚠ THE EFFECTIVE WINDOW IS 120 SECONDS, NOT 60. `iron-webcrypto` (via `iron-session`) adds a
 * FIXED 60-second clock-skew allowance ON TOP of `ttl` before it calls a seal expired, so a
 * `ttl: 60` token is accepted for up to 120s. `switch-token.test.ts` pins both ends of that.
 *
 * ⚠ LOWERING THIS BARELY HELPS: the skew dominates. At `ttl: 5` the outer bound is still 65s,
 * so the constant can buy at most ~55s of the 120. Shrinking the window meaningfully would
 * take real single-use state (a table or Redis), which the replay analysis above argues is not
 * worth it — a replay can only re-select a workspace the victim already holds.
 */
export const WORKSPACE_SWITCH_TOKEN_TTL_SECONDS = 60;

/** The query-string parameter carrying the sealed token. */
export const WORKSPACE_SWITCH_TOKEN_PARAM = 't';

/**
 * DOMAIN SEPARATION between this seal and the `balo_session` seal, which share one password.
 *
 * ⚠ EXPORTED SO THE TEST CANNOT DRIFT: `switch-token.test.ts` seals a purpose-less payload
 * with raw `sealData` and asserts rejection, and it must reference the same literal this
 * module asserts on rather than a hand-copied string.
 */
export const WORKSPACE_SWITCH_TOKEN_PURPOSE = 'workspace_switch';

/**
 * Seal a switch authorization. Uses the SAME password source as the session cookie
 * (`@/lib/auth/session-config`) — deliberately NOT a new env var, so there is one secret to
 * rotate and no new deployment prerequisite.
 */
export async function sealWorkspaceSwitchToken(payload: WorkspaceSwitchToken): Promise<string> {
  return sealData(
    {
      // Not part of `WorkspaceSwitchToken`: callers must not be able to choose it, and no
      // caller has anything to say about it. It exists on the WIRE only.
      purpose: WORKSPACE_SWITCH_TOKEN_PURPOSE,
      userId: payload.userId,
      targetKey: payload.targetKey,
      returnTo: payload.returnTo,
    },
    { password: sessionConfig.password, ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS }
  );
}

/**
 * `null` for a missing, malformed, tampered, wrong-password, WRONG-PURPOSE or EXPIRED token.
 * `unsealData` returns `{}` (it does not throw) for expiry / bad hmac / unknown password, so
 * the shape check below is what actually rejects those — it is not defensive padding.
 */
export async function unsealWorkspaceSwitchToken(
  raw: string | null | undefined
): Promise<WorkspaceSwitchToken | null> {
  if (raw === null || raw === undefined || raw === '') return null;

  try {
    const data = await unsealData<Partial<WorkspaceSwitchToken> & { purpose?: unknown }>(raw, {
      password: sessionConfig.password,
      ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS,
    });

    // Checked FIRST: a seal minted for another purpose with the shared session password is
    // rejected on the discriminator, not incidentally on a field it happens not to carry.
    if (data.purpose !== WORKSPACE_SWITCH_TOKEN_PURPOSE) return null;

    const { userId, targetKey, returnTo } = data;
    if (typeof userId !== 'string' || userId === '') return null;
    if (typeof targetKey !== 'string' || targetKey === '') return null;
    if (typeof returnTo !== 'string' || returnTo === '') return null;

    return { userId, targetKey, returnTo };
  } catch (error) {
    // A structurally invalid seal makes iron-session throw before it can return `{}`.
    // Treated exactly like expiry — the caller redirects without switching.
    log.warn('Workspace switch token could not be unsealed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
