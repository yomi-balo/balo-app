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
import { MuxConfigError } from './errors.js';

/** ⚠ A CEILING, NOT A SUGGESTION. {@link clampTtlSeconds} CLAMPS any larger request down to this. */
export const MUX_PLAYBACK_MAX_TTL_SECONDS = 2 * 60 * 60; // 2h
export const MUX_PLAYBACK_DEFAULT_TTL_SECONDS = 60 * 60; // 1h
const MUX_PLAYBACK_MIN_TTL_SECONDS = 60;

/**
 * Clamp to `[60, MUX_PLAYBACK_MAX_TTL_SECONDS]`. A caller asking for a day gets two hours,
 * silently.
 *
 * ⚠⚠ FIX ROUND 1 (F11) — `Number.isFinite` GUARDS `NaN` (and `±Infinity`), because
 * `Math.min`/`Math.max` PROPAGATE `NaN` rather than clamping it: `clampTtlSeconds(NaN)`
 * returned `NaN`, which became `expiration: "NaNs"` on the signed JWT. Not a clamp bypass —
 * Mux would reject the token — but a caller-supplied non-numeric TTL should fall back to the
 * default, not manufacture a malformed expiration.
 */
function clampTtlSeconds(ttlSeconds: number | undefined): number {
  const requested =
    ttlSeconds !== undefined && Number.isFinite(ttlSeconds)
      ? ttlSeconds
      : MUX_PLAYBACK_DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(requested, MUX_PLAYBACK_MIN_TTL_SECONDS), MUX_PLAYBACK_MAX_TTL_SECONDS);
}

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
  const ttl = clampTtlSeconds(ttlSeconds);
  const token = await jwtClient().jwt.signPlaybackId(playbackId, {
    keyId: signingKeyId(),
    keySecret: signingKeyPrivate(),
    type: 'video',
    expiration: `${ttl}s`,
  });
  return `https://stream.mux.com/${playbackId}.m3u8?token=${token}`;
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
  const ttl = clampTtlSeconds(options?.ttlSeconds);
  const timeSeconds = options?.timeSeconds;
  const token = await jwtClient().jwt.signPlaybackId(playbackId, {
    keyId: signingKeyId(),
    keySecret: signingKeyPrivate(),
    type: 'thumbnail',
    expiration: `${ttl}s`,
    ...(timeSeconds === undefined ? {} : { params: { time: String(timeSeconds) } }),
  });
  const timeQuery = timeSeconds === undefined ? '' : `&time=${timeSeconds}`;
  return `https://image.mux.com/${playbackId}/thumbnail.jpg?token=${token}${timeQuery}`;
}
