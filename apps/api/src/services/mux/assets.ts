/**
 * BAL-473 — `createSignedAssetFromUrl()`, the ONLY `video.assets.create` call site in this
 * feature. Called from `recording-ingest`, and ONLY from there.
 */
import { getMuxClient } from './client.js';

/**
 * OD-4 — Mux has no 720p tier. `video_quality: 'basic'` is the cost/quality tier the ticket's
 * "720p per ADR-1013" line meant; resolution is a SEPARATE knob (`max_resolution_tier`,
 * default `'1080p'`, no lower value) and is deliberately left UNSET so the asset inherits the
 * account default rather than this feature encoding a resolution policy it was never asked to
 * set. ADR-1013's cost table predates the 2024 Mux tier rename and is stale — flagged as a
 * follow-up in the PR body, not edited here (OD-4).
 */
const VIDEO_QUALITY = 'basic';

export interface CreateSignedAssetFromUrlInput {
  /** The Daily source's short-lived access-link URL — never logged, never persisted. */
  url: string;
  /** `meeting_recordings.id` — OD-1's correlation key, echoed back on every Mux webhook. */
  passthrough: string;
}

export interface CreatedMuxAsset {
  /** The Mux ASSET id — an API handle. NEVER client-reachable; see `@balo/shared/meetings`. */
  id: string;
}

/**
 * Create ONE Mux asset from the Daily source, with a SIGNED (never public) playback policy.
 *
 * ⚠⚠ THE SETTLED CONFIG, PINNED BY `assets.test.ts`'S DEEP-EQUAL — do not add a knob
 * speculatively; `.claude/skills/mux/SKILL.md` names each of these as settled:
 *   · `inputs` (PLURAL) — `input` is deprecated; using it risks a future SDK major dropping it.
 *   · `playback_policy: ['signed']` — NEVER `'public'`. A public playback id is playable by
 *     anyone holding it, forever, with no token; this feature has exactly one policy.
 *   · `passthrough` — the ONLY correlation Mux hands back on every webhook. Set on every create.
 *   · `video_quality: 'basic'` — see the module docblock. `max_resolution_tier` is NOT sent.
 */
export async function createSignedAssetFromUrl(
  input: CreateSignedAssetFromUrlInput
): Promise<CreatedMuxAsset> {
  const asset = await getMuxClient().video.assets.create({
    inputs: [{ url: input.url }],
    playback_policy: ['signed'],
    passthrough: input.passthrough,
    video_quality: VIDEO_QUALITY,
  });
  return { id: asset.id };
}
