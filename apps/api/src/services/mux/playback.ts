/**
 * BAL-473 (§9) — THE SIGNED PLAYBACK SERVICE. Server-only, exports NO route in this PR —
 * BAL-440 is its first production caller.
 *
 * ── HOW THIS STAYS SERVER-ONLY — THREE INDEPENDENT MECHANISMS, NONE OF WHICH IS A COMMENT ──
 *
 *   1. It lives in `apps/api/src/services/`. `apps/web` has no path mapping to `apps/api`,
 *      `apps/api` is not a workspace package, and nothing in `apps/web`'s dependency graph can
 *      reach it. This is STRUCTURAL, not conventional.
 *   2. It exports NO ROUTE. `app.ts` gains only `muxRoutes` (the webhook); there is no
 *      `GET /recordings/:id/playback` anywhere in this PR.
 *   3. The signing keys are read from `process.env` inside `apps/api` only, and neither
 *      `MUX_SIGNING_KEY_*` var is `NEXT_PUBLIC_`-prefixed, so Next.js could not inline them
 *      even if a file did reach the client graph.
 *
 * ⚠ NEVER LOG OR PERSIST THE RETURNED URL OR TOKEN. Log the playback id and the TTL, if
 * anything — the token is a live, bearer credential to a (currently unpublished) recording.
 */
import Mux from '@mux/mux-node';
import {
  signMuxPlaybackUrl,
  signMuxThumbnailUrl,
  MUX_PLAYBACK_DEFAULT_TTL_SECONDS,
  MUX_PLAYBACK_MAX_TTL_SECONDS,
} from '@balo/shared/meetings';
import { MuxConfigError } from './errors.js';

/**
 * BAL-440 — THE TTL CONSTANTS, THE CLAMP, THE OPTION-SHAPING LOGIC, AND (as of fix round 1,
 * m8) THE WHOLE SIGNING ROUTINE now live in `@balo/shared/meetings` (`mux-playback-policy.ts`'s
 * `signMuxPlaybackUrl` / `signMuxThumbnailUrl`); the two TTL constants below are RE-EXPORTED so
 * this module's own callers (and its test, which asserts against these names) compile
 * unchanged. `apps/web/src/lib/mux/playback.ts` is the second signer against the SAME policy —
 * see that module's docblock and plan §2 for why the policy AND the option/URL-templating logic
 * are hoisted while the vendor SDK CLIENT (`new Mux(...)`) is not: hoisting the SDK call itself
 * would pull `@mux/mux-node` behind the `@balo/shared/meetings` barrel and break `next build`
 * for every client component importing it (memory `reference_balo_db_client_bundle_footgun`).
 * Each app therefore constructs its own throwaway client and hands the shared routine its
 * `jwt.signPlaybackId` method as the `sign` callback — dependency injection, not a second
 * definition of the signing logic.
 */
export { MUX_PLAYBACK_DEFAULT_TTL_SECONDS, MUX_PLAYBACK_MAX_TTL_SECONDS };

/**
 * Keys read LAZILY, INSIDE A FUNCTION — never a module-level `const`. `getDailyApiKey`'s
 * pattern, restated: a module-level read would fail merely IMPORTING this module in every
 * test and route that does not need signed playback.
 *
 * `MUX_SIGNING_KEY_PRIVATE` is the BASE64 PEM Mux hands out — passed straight through as the
 * SDK's `keySecret`, never re-encoded; the SDK's own `getPrivateKeyHelper` base64-decodes it.
 */
function signingKeyId(): string {
  const keyId = process.env.MUX_SIGNING_KEY_ID;
  if (!keyId) {
    throw new MuxConfigError('MUX_SIGNING_KEY_ID is not set');
  }
  return keyId;
}
function signingKeyPrivate(): string {
  const key = process.env.MUX_SIGNING_KEY_PRIVATE;
  if (!key) {
    throw new MuxConfigError('MUX_SIGNING_KEY_PRIVATE is not set');
  }
  return key;
}

/**
 * A THROWAWAY SDK CLIENT FOR JWT SIGNING ONLY — deliberately NOT `getMuxClient()`, the same
 * reasoning as `webhook-signature.ts`'s `verificationClient()`: signing needs no API token,
 * and each of the five `MUX_*` vars has an INDEPENDENT absent-key behaviour.
 */
function jwtClient(): Mux {
  return new Mux({ tokenId: null, tokenSecret: null });
}

/**
 * A signed HLS manifest URL for `playbackId`, valid for `ttlSeconds` (clamped).
 * `aud: 'v'` (`TypeClaim.video`), RS256, key id carried as `keyid` → the JWT's `kid`.
 */
export async function signedPlaybackUrl(playbackId: string, ttlSeconds?: number): Promise<string> {
  const client = jwtClient();
  return signMuxPlaybackUrl(
    (id, options) => client.jwt.signPlaybackId(id, options),
    playbackId,
    { keyId: signingKeyId(), keySecret: signingKeyPrivate() },
    ttlSeconds
  );
}

/**
 * A signed thumbnail URL for `playbackId`. `aud: 't'` (`TypeClaim.thumbnail`). When
 * `timeSeconds` is supplied it is embedded as a signed `time` claim AND appended to the URL
 * (`&time=`) — Mux's edge validates the query param against the claim, so the two must match.
 */
export async function signedThumbnailUrl(
  playbackId: string,
  options?: { ttlSeconds?: number; timeSeconds?: number }
): Promise<string> {
  const client = jwtClient();
  return signMuxThumbnailUrl(
    (id, opts) => client.jwt.signPlaybackId(id, opts),
    playbackId,
    { keyId: signingKeyId(), keySecret: signingKeyPrivate() },
    options
  );
}
