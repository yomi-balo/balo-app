import 'server-only';

import Mux from '@mux/mux-node';
import { signMuxPlaybackUrl, signMuxThumbnailUrl } from '@balo/shared/meetings';

/**
 * BAL-440 (plan §2, verdict A′) — THE SECOND MUX SIGNER, in `apps/web`, alongside
 * `apps/api/src/services/mux/playback.ts`. The signed playback URL must be minted behind the
 * SAME authorization the recap read already uses (`authorizeMeetingFileAccess`, `apps/web`-only,
 * no `apps/api` counterpart) — so the mint runs here rather than crossing a trust boundary and a
 * network hop to sign in the other app. See the plan's §2 for the full rejection of the
 * alternatives (a Fastify route, or hoisting the whole signer — SDK included — into
 * `@balo/shared`).
 *
 * ⚠ THE WHOLE SIGNING ROUTINE (TTL bounds, TTL-for-duration, the two URL templates, the
 * option-shaping AND the SDK-call wiring) IS NOT RESTATED HERE — it is imported from
 * `@balo/shared/meetings` (`mux-playback-policy.ts`'s `signMuxPlaybackUrl` /
 * `signMuxThumbnailUrl`), the ONE definition both signers share (BAL-440 fix round 1, m8). Only
 * the vendor SDK CLIENT CONSTRUCTION (`new Mux(...)`) and key-reading exist twice, because
 * `@mux/mux-node` itself must never be imported by the shared, PURE module (memory
 * `reference_balo_db_client_bundle_footgun`) — this file passes its own client's
 * `jwt.signPlaybackId` in as the `sign` callback rather than letting the shared module call the
 * SDK directly.
 *
 * ⚠⚠ NEVER LOG OR PERSIST THE RETURNED URL OR TOKEN. This module imports NO logger at all —
 * `playback.test.ts` asserts that by mocking `@/lib/logging` and asserting zero calls after
 * every signing call this file makes.
 */

/**
 * Keys read LAZILY, INSIDE A FUNCTION — never a module-level `const`. A module-level read would
 * fail merely IMPORTING this module in every test and route that does not need signed playback.
 *
 * `MUX_SIGNING_KEY_PRIVATE` is the BASE64 PEM Mux hands out — passed straight through as the
 * SDK's `keySecret`, never re-encoded; the SDK's own `getPrivateKeyHelper` base64-decodes it.
 *
 * ⚠ PLAIN `Error`, NOT `apps/api`'s `MuxConfigError`. That class is structurally unreachable
 * from here (it lives in `apps/api/src/services/mux/errors.ts`, a different app), and a second
 * error taxonomy earns nothing — both call sites (this module's own callers, and
 * `map-recap-recordings.ts` / `get-meeting-recording-playback.ts`) catch broadly.
 */
function signingKeyId(): string {
  const keyId = process.env.MUX_SIGNING_KEY_ID;
  if (!keyId) {
    throw new Error('MUX_SIGNING_KEY_ID is not set');
  }
  return keyId;
}
function signingKeyPrivate(): string {
  const key = process.env.MUX_SIGNING_KEY_PRIVATE;
  if (!key) {
    throw new Error('MUX_SIGNING_KEY_PRIVATE is not set');
  }
  return key;
}

/**
 * A THROWAWAY SDK CLIENT FOR JWT SIGNING ONLY — signing needs no API token, and each of the
 * `MUX_*` vars has an INDEPENDENT absent-key behaviour (only `MUX_SIGNING_KEY_ID` and
 * `MUX_SIGNING_KEY_PRIVATE` are provisioned on Vercel at all — see `.env.example`).
 */
function jwtClient(): Mux {
  return new Mux({ tokenId: null, tokenSecret: null });
}

/**
 * A signed HLS manifest URL for `playbackId`, valid for `ttlSeconds` (clamped by the shared
 * policy). `aud: 'v'` (video), RS256, key id carried as `keyid` → the JWT's `kid`.
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
 * A signed thumbnail URL for `playbackId`. `aud: 't'` (thumbnail) — a video token will not sign
 * a thumbnail. When `timeSeconds` is supplied it is embedded as a signed `time` claim AND
 * appended to the URL — Mux's edge validates the query param against the claim, so the two must
 * match.
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
