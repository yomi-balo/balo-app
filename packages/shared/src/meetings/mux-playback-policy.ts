/**
 * BAL-440 — THE SINGLE DEFINITION of every Mux-playback-signing fact the two signers
 * (`apps/web/src/lib/mux/playback.ts`, `apps/api/src/services/mux/playback.ts`) must not be
 * allowed to drift on: the TTL bounds, the TTL-for-a-recording's-length policy, and the two
 * URL templates.
 *
 * ⚠⚠ PURE, ZERO IMPORTS — not even `server-only`, not even a type from `@balo/db`. This module
 * sits behind the `@balo/shared/meetings` BARREL, and that barrel is reached by CLIENT
 * components (`recording-view.ts` already documents the rule). An `@mux/mux-node`
 * value-import here would drag a Node-only SDK into every client bundle that imports
 * `@balo/shared/meetings` and fail `next build` (memory
 * `reference_balo_db_client_bundle_footgun`, restated for a second vendor SDK). The two apps'
 * signers import the SDK themselves and call into this module for the policy only.
 */

/** ⚠ A CEILING, NOT A SUGGESTION. {@link clampMuxTtlSeconds} clamps any larger request down. */
export const MUX_PLAYBACK_MAX_TTL_SECONDS = 2 * 60 * 60; // 2h
export const MUX_PLAYBACK_DEFAULT_TTL_SECONDS = 60 * 60; // 1h
export const MUX_PLAYBACK_MIN_TTL_SECONDS = 60;

/**
 * Pause/scrub headroom added on top of a recording's own length (BAL-440 C-2). The Mux
 * signed token governs the manifest AND its segments, so a TTL shorter than the recording
 * itself stops playback mid-view — this is the margin that keeps a token outliving the thing
 * it plays.
 */
export const MUX_PLAYBACK_TTL_HEADROOM_SECONDS = 15 * 60;

/**
 * Clamp to `[MUX_PLAYBACK_MIN_TTL_SECONDS, MUX_PLAYBACK_MAX_TTL_SECONDS]`.
 *
 * ⚠⚠ `Number.isFinite` GUARDS `NaN` (and `±Infinity`) EXPLICITLY, because `Math.min`/`Math.max`
 * PROPAGATE `NaN` rather than clamping it — an un-guarded `NaN` would manufacture a malformed
 * `expiration` on the signed JWT rather than falling back to a sane default. `undefined` or any
 * non-finite value therefore falls back to {@link MUX_PLAYBACK_DEFAULT_TTL_SECONDS} before the
 * clamp runs.
 */
export function clampMuxTtlSeconds(ttlSeconds: number | undefined): number {
  const requested =
    ttlSeconds !== undefined && Number.isFinite(ttlSeconds)
      ? ttlSeconds
      : MUX_PLAYBACK_DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(requested, MUX_PLAYBACK_MIN_TTL_SECONDS), MUX_PLAYBACK_MAX_TTL_SECONDS);
}

/**
 * BAL-440 (C-2) — a token that outlives the thing it plays. `durationSeconds + 15 min`
 * headroom, always run back through {@link clampMuxTtlSeconds} so the 2h ceiling still binds
 * (a recording longer than ~1h45m is capped there; a continuous viewer who outlasts it closes
 * and reopens, which re-mints — documented in the plan, not solved here).
 *
 * `null` duration (a recording Mux never reported a length for) yields headroom alone —
 * clamped up to the 60s floor if that ever changes, though 900s already clears it today.
 */
export function playbackTtlForDuration(durationSeconds: number | null): number {
  const base = durationSeconds === null || !Number.isFinite(durationSeconds) ? 0 : durationSeconds;
  return clampMuxTtlSeconds(base + MUX_PLAYBACK_TTL_HEADROOM_SECONDS);
}

/** `https://stream.mux.com/{playbackId}.m3u8?token={token}` */
export function muxPlaybackManifestUrl(playbackId: string, token: string): string {
  return `https://stream.mux.com/${playbackId}.m3u8?token=${token}`;
}

/**
 * `https://image.mux.com/{playbackId}/thumbnail.jpg?token={token}[&time=N]`
 *
 * ⚠ When `timeSeconds` is given it must ALSO be a signed `time` claim on the token — Mux's
 * edge validates the query param against the claim. The caller (the signer, in each app) signs
 * the claim; this function only formats the URL.
 */
export function muxThumbnailUrl(playbackId: string, token: string, timeSeconds?: number): string {
  const timeQuery = timeSeconds === undefined ? '' : `&time=${timeSeconds}`;
  return `https://image.mux.com/${playbackId}/thumbnail.jpg?token=${token}${timeQuery}`;
}

/**
 * The exact options object `@mux/mux-node`'s `jwt.signPlaybackId` needs to mint a VIDEO
 * playback token. `aud: 'v'` (video) — a video token will not sign a thumbnail.
 *
 * ⚠ PURE — builds a plain data object, no SDK import. This is what lets BOTH signers
 * (`apps/web/src/lib/mux/playback.ts`, `apps/api/src/services/mux/playback.ts`) share the
 * option-shaping logic (the clamp, the `${ttl}s` format) while each keeps its OWN `new Mux(...)`
 * call — the vendor SDK itself is never imported here. Reduces the two signers' duplicated
 * surface to the key-reading functions and a one-line SDK call each (memory
 * `reference_sonar_duplication_not_caught_locally` — verified with `npx jscpd`).
 */
export interface MuxVideoSigningOptions {
  keyId: string;
  keySecret: string;
  type: 'video';
  expiration: string;
}
export function muxVideoSigningOptions(
  keyId: string,
  keySecret: string,
  ttlSeconds: number | undefined
): MuxVideoSigningOptions {
  return { keyId, keySecret, type: 'video', expiration: `${clampMuxTtlSeconds(ttlSeconds)}s` };
}

/**
 * The exact options object for a THUMBNAIL token. `aud: 't'`. When `timeSeconds` is supplied it
 * becomes the signed `params.time` claim — `muxThumbnailUrl`'s `&time=` query param is validated
 * against this claim at Mux's edge, so the caller must pass the SAME `timeSeconds` to both.
 */
export interface MuxThumbnailSigningOptions {
  keyId: string;
  keySecret: string;
  type: 'thumbnail';
  expiration: string;
  params?: { time: string };
}
export function muxThumbnailSigningOptions(
  keyId: string,
  keySecret: string,
  options?: { ttlSeconds?: number; timeSeconds?: number }
): MuxThumbnailSigningOptions {
  const timeSeconds = options?.timeSeconds;
  return {
    keyId,
    keySecret,
    type: 'thumbnail',
    expiration: `${clampMuxTtlSeconds(options?.ttlSeconds)}s`,
    ...(timeSeconds === undefined ? {} : { params: { time: String(timeSeconds) } }),
  };
}

/** Key material for a signer, read by each app from `process.env` and handed in as data. */
export interface MuxSigningKeys {
  keyId: string;
  keySecret: string;
}

/**
 * A caller-supplied signing function — in practice `(id, config) => client.jwt.signPlaybackId(id,
 * config)` closed over a throwaway `Mux` SDK client each app constructs itself. `TOptions` is
 * pinned per call site ({@link MuxVideoSigningOptions} or {@link MuxThumbnailSigningOptions}, never
 * their union) so the caller's arrow function stays a plain, single-overload call into the SDK —
 * no union-typed argument for `signPlaybackId`'s overload resolution to choke on.
 *
 * ⚠⚠ THIS IS A FUNCTION **PARAMETER**, NEVER AN IMPORT. Taking the signer as data (dependency
 * injection) is what lets {@link signMuxPlaybackUrl} / {@link signMuxThumbnailUrl} live in this
 * PURE, ZERO-IMPORT module while still doing the real signing work — see the module docblock.
 */
export type MuxPlaybackIdSigner<TOptions> = (
  playbackId: string,
  options: TOptions
) => Promise<string>;

/**
 * BAL-440 fix round 1 (m8) — THE WHOLE video-signing routine (option-shaping + the SDK call,
 * via `sign` + URL templating), hoisted here so `apps/web/src/lib/mux/playback.ts` and
 * `apps/api/src/services/mux/playback.ts` each collapse to key-reading, a throwaway `new
 * Mux(...)` client, and one call into this function — cutting the two signers' duplicated
 * surface from the whole ~40-line routine down to the vendor-client construction alone
 * (verified with `npx jscpd`, memory `reference_sonar_duplication_not_caught_locally`).
 */
export async function signMuxPlaybackUrl(
  sign: MuxPlaybackIdSigner<MuxVideoSigningOptions>,
  playbackId: string,
  keys: MuxSigningKeys,
  ttlSeconds?: number
): Promise<string> {
  const token = await sign(
    playbackId,
    muxVideoSigningOptions(keys.keyId, keys.keySecret, ttlSeconds)
  );
  return muxPlaybackManifestUrl(playbackId, token);
}

/** The thumbnail counterpart of {@link signMuxPlaybackUrl} — same hoisting, same reasoning. */
export async function signMuxThumbnailUrl(
  sign: MuxPlaybackIdSigner<MuxThumbnailSigningOptions>,
  playbackId: string,
  keys: MuxSigningKeys,
  options?: { ttlSeconds?: number; timeSeconds?: number }
): Promise<string> {
  const token = await sign(
    playbackId,
    muxThumbnailSigningOptions(keys.keyId, keys.keySecret, options)
  );
  return muxThumbnailUrl(playbackId, token, options?.timeSeconds);
}
