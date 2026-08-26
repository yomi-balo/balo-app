/**
 * BAL-473 (§8.6) — THE ZOD BOUNDARY FOR MUX'S WEBHOOK PAYLOADS. Mirrors
 * `services/daily/webhook-events.ts`'s discipline: vendor bodies are asserted NOWHERE ELSE in
 * this feature.
 *
 * ⚠ `id` IS REQUIRED — without it `mux_webhook_events`'s marker cannot do its job. Every other
 * type is a first-class `unhandled` outcome, never an error: a `500` on a Mux event type this
 * platform does not act on would flood the vendor's retry queue and eventually get the webhook
 * DISABLED, taking `video.asset.ready` / `video.asset.errored` down with it.
 *
 * `.passthrough()` is NOT used — Zod strips unknown keys by default, which is right here too:
 * nothing downstream may read a field this module has not named.
 */
import { z } from 'zod';

const envelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created_at: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type MuxWebhookEvent =
  | {
      readonly kind: 'video.asset.ready';
      readonly eventId: string;
      readonly type: string;
      /** `meeting_recordings.id`, echoed back on `data.passthrough`. `null` when absent OR not a UUID. */
      readonly passthrough: string | null;
      readonly assetId: string | null;
      /**
       * The `playback_ids` entry whose `policy === 'signed'`. `null` when the asset carries
       * NONE — the caller must refuse the `ready` transition rather than half-stamp the row;
       * see `routes/mux/webhook.ts` §8.3.
       */
      readonly playbackId: string | null;
      /** `Math.round(data.duration)` when finite non-negative, else `null` — never a guess. */
      readonly durationSeconds: number | null;
    }
  | {
      readonly kind: 'video.asset.errored';
      readonly eventId: string;
      readonly type: string;
      readonly passthrough: string | null;
      readonly assetId: string | null;
      /** Joined from `data.errors.messages`, bounded — the repository caps it further. */
      readonly errorMessage: string | null;
    }
  | {
      /** A type Balo does not act on, or a handled type missing what it needs. */
      readonly kind: 'unhandled';
      readonly eventId: string;
      readonly type: string;
      readonly passthrough: string | null;
    };

export type ParseMuxWebhookResult =
  | { readonly ok: true; readonly event: MuxWebhookEvent }
  | { readonly ok: false; readonly reason: 'malformed_envelope' };

const uuidSchema = z.string().uuid();

/**
 * `data.passthrough` — `meeting_recordings.id`, when the delivery carries one.
 *
 * ⚠⚠ FIX ROUND 1 (F3) — REQUIRED TO BE A UUID, because it is OUR OWN id, minted by
 * `recording-ingest` and echoed back on `assets.create`'s `passthrough`. `findById` binds it
 * to a `uuid` column, so a non-UUID value (a dashboard-created asset, or a future feature in
 * the same Mux environment) reached Postgres as `22P02` → an uncaught `500` → Mux retries the
 * SAME undying delivery forever, taking every genuine `video.asset.ready` down with it (the
 * marker is written AFTER `resolveEffect`, so nothing short-circuits the retry). A non-UUID is
 * by definition not ours — degrade to `null` and fall through to the `mux_asset_id` lookup,
 * mirroring `daily/webhook-events.ts`'s `instanceIdFrom`.
 */
function passthroughFrom(data: Record<string, unknown> | undefined): string | null {
  const value = data?.passthrough;
  return typeof value === 'string' && uuidSchema.safeParse(value).success ? value : null;
}

/** `data.id` — the Mux ASSET id (the fallback correlation lookup). */
function assetIdFrom(data: Record<string, unknown> | undefined): string | null {
  const value = data?.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const playbackIdEntrySchema = z.object({
  id: z.string().min(1).optional(),
  policy: z.string().optional(),
});

/** The `playback_ids` entry whose `policy === 'signed'`, if any. */
function signedPlaybackIdFrom(data: Record<string, unknown> | undefined): string | null {
  const raw = data?.playback_ids;
  if (!Array.isArray(raw)) {
    return null;
  }
  for (const entry of raw) {
    const parsed = playbackIdEntrySchema.safeParse(entry);
    if (parsed.success && parsed.data.policy === 'signed' && parsed.data.id !== undefined) {
      return parsed.data.id;
    }
  }
  return null;
}

/** `data.duration` — a finite non-negative number, rounded. Anything else ⇒ `null`. */
function durationSecondsFrom(data: Record<string, unknown> | undefined): number | null {
  const value = data?.duration;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** `MAX` chars of `data.errors.messages`, joined — the repository caps it further to 500. */
const ERROR_MESSAGE_JOIN_MAX = 1000;
function errorMessageFrom(data: Record<string, unknown> | undefined): string | null {
  const errors = data?.errors as { messages?: unknown } | undefined;
  const messages = errors?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const joined = messages.filter((m): m is string => typeof m === 'string').join('; ');
  return joined.length > 0 ? joined.slice(0, ERROR_MESSAGE_JOIN_MAX) : null;
}

/** Parse one Mux webhook delivery, already verified by {@link verifyMuxWebhookSignature}. */
export function parseMuxWebhookEvent(body: unknown): ParseMuxWebhookResult {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed_envelope' };
  }

  const { id: eventId, type, data } = parsed.data;
  const passthrough = passthroughFrom(data);

  if (type === 'video.asset.ready') {
    return {
      ok: true,
      event: {
        kind: 'video.asset.ready',
        eventId,
        type,
        passthrough,
        assetId: assetIdFrom(data),
        playbackId: signedPlaybackIdFrom(data),
        durationSeconds: durationSecondsFrom(data),
      },
    };
  }

  if (type === 'video.asset.errored') {
    return {
      ok: true,
      event: {
        kind: 'video.asset.errored',
        eventId,
        type,
        passthrough,
        assetId: assetIdFrom(data),
        errorMessage: errorMessageFrom(data),
      },
    };
  }

  return { ok: true, event: { kind: 'unhandled', eventId, type, passthrough } };
}
