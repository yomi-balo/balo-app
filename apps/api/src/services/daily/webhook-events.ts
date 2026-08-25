/**
 * BAL-134 (§5.1) — THE ZOD BOUNDARY FOR DAILY'S WEBHOOK PAYLOADS. Vendor bodies are asserted
 * NOWHERE ELSE in this feature.
 *
 * ⚠⚠ THIS IS THE ONE PLACE A DAILY PAYLOAD IS PARSED RATHER THAN CAST. `client.ts`'s
 * `dailyRequest` ends in a bare `as T`, which is tolerable for a REST response we asked for;
 * it is not tolerable for an UNSOLICITED body that reaches a MONEY WRITE. Everything
 * downstream — the presence writer, the room→meeting lookup — receives parsed, narrowed values.
 *
 * ⚠ DELIBERATELY PERMISSIVE ABOUT SHAPE, STRICT ABOUT WHAT IT USES. The exact field names
 * could not be verified against `docs.daily.co` from the session that wrote this (the
 * `daily-co` skill has no webhook section — see `webhook-signature.ts`'s header), so each
 * arm accepts the plausible spellings for the three values it needs and REFUSES rather than
 * guesses when none is present:
 *
 *   · the ROOM      — `payload.room` or `payload.room_name`;
 *   · the PARTICIPANT — `payload.user_id` (the claim BAL-132 minted) or `payload.userId`;
 *   · the INSTANT   — the event's own `joined_at` / `left_at` if present, else the envelope's
 *     `event_ts` (unix seconds).
 *
 * ⚠ AN UNKNOWN TYPE IS A FIRST-CLASS OUTCOME, NOT AN ERROR. Daily fires event types Balo does
 * not handle, and a `500` on one of those would flood the vendor's retry queue and eventually
 * get the webhook DISABLED — taking the three types we DO care about down with it. Unknown
 * types record their marker and ack `200`.
 *
 * ⚠ THE ENVELOPE'S `id` IS THE IDEMPOTENCY KEY and is REQUIRED. Without it the
 * `daily_webhook_events` marker cannot do its job (D2), and a replayed `participant.joined`
 * after a legitimate close would open a second interval anchored in the past — a silent,
 * unbounded over-bill on a money path. A body with no id is refused.
 *
 * ── BAL-473 — THE THREE RECORDING ARMS, AND THE TRAP THIS FILE MUST NOT FALL INTO ─────────
 *
 * `recording.started`'s payload carries `recording_id`, `action`, `layout`, `started_by`,
 * `instance_id`, `start_ts` — verified against docs.daily.co — **NO `room_name`**. Naively
 * folding it into the "a handled type with no resolvable room degrades to `unhandled`" rule
 * below would silently swallow EVERY `recording.started` delivery: `daily_recording_id` would
 * never be stamped from it, and the feature would still *appear* to work (the
 * `ready-to-download` fallback backfills it) while `recording.started` was dead. So the
 * room-name requirement below is a property of the PRESENCE/MEETING arms only — the recording
 * arms are resolved by `instance_id` / `recording_id` and gate on THOSE instead.
 */
import { z } from 'zod';

/** The six types this feature acts on. Everything else acks and does nothing. */
export const HANDLED_DAILY_EVENT_TYPES = [
  'participant.joined',
  'participant.left',
  'meeting.ended',
  // BAL-473 — the recording arms. ⚠ `recording.started` carries NO `room_name`; see above.
  'recording.started',
  'recording.ready-to-download',
  'recording.error',
] as const;

export type HandledDailyEventType = (typeof HANDLED_DAILY_EVENT_TYPES)[number];

/**
 * The delivery envelope, common to every Daily event.
 *
 * ⚠ `.passthrough()` IS NOT USED AND NOT NEEDED — Zod strips unknown keys by default, which is
 * exactly right here: nothing downstream may reach a field this module has not named, so a
 * vendor adding one cannot silently become an input. The RAW BYTES are still what the
 * signature covers; this parse happens after verification and governs only what Balo READS.
 */
const envelopeSchema = z.object({
  /** Daily's event id — the natural idempotency key. ⚠ REQUIRED; see the module docblock. */
  id: z.string().min(1),
  type: z.string().min(1),
  /** Unix SECONDS. Optional — each arm falls back to its own timestamp field, then to this. */
  event_ts: z.number().finite().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** A room name as either spelling. `null` when the event names no room. */
function roomNameFrom(payload: Record<string, unknown> | undefined): string | null {
  const room = payload?.room ?? payload?.room_name;
  return typeof room === 'string' && room.length > 0 ? room : null;
}

/** The Daily `user_id` CLAIM as either spelling. `null` ⇒ identity unknown, never a guess. */
function participantIdFrom(payload: Record<string, unknown> | undefined): string | null {
  const id = payload?.user_id ?? payload?.userId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

const uuidSchema = z.string().uuid();

/**
 * BAL-473 — `payload.instance_id` (either spelling), REQUIRED to be a UUID because it is
 * OUR OWN id (`meeting_recordings.id`, minted by `recording-ensure`). A non-UUID is by
 * definition not ours — refuse rather than guess.
 */
function instanceIdFrom(payload: Record<string, unknown> | undefined): string | null {
  const id = payload?.instance_id ?? payload?.instanceId;
  return typeof id === 'string' && uuidSchema.safeParse(id).success ? id : null;
}

/** BAL-473 — `payload.recording_id` (either spelling) — Daily's own recording id. */
function dailyRecordingIdFrom(payload: Record<string, unknown> | undefined): string | null {
  const id = payload?.recording_id ?? payload?.recordingId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * BAL-473 — `payload.duration`, a finite non-negative number, rounded to an integer.
 * Anything else (absent, negative, non-finite) ⇒ `null` — the pre-flight could not confirm
 * this field exists on `recording.ready-to-download`, and Mux's `video.asset.ready` duration
 * overwrites it anyway once the segment is `ready`.
 */
function durationFrom(payload: Record<string, unknown> | undefined): number | null {
  const value = payload?.duration;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** BAL-473 — `payload.error_msg` (either spelling), Daily's `recording.error` text. */
function errorMsgFrom(payload: Record<string, unknown> | undefined): string | null {
  const msg = payload?.error_msg ?? payload?.errorMsg;
  return typeof msg === 'string' && msg.length > 0 ? msg : null;
}

/**
 * One instant from a vendor field, in whichever of the three shapes Daily uses.
 *
 * ⚠ IT RETURNS AN **INVALID DATE** RATHER THAN `null` FOR A PRESENT-BUT-UNPARSEABLE VALUE, and
 * that difference is load-bearing. `null` means "the vendor did not tell us when", which the
 * caller answers by falling back to the envelope; an Invalid Date means "the vendor told us
 * something we cannot interpret", which must NOT be silently replaced by a plausible instant on
 * a billing clock. It travels to the presence write seam, where
 * `InvalidPresenceTimestampError` rejects it loudly (edge case 22) and the route still acks
 * `200` so Daily does not retry a body that will never be writable.
 */
function instantFrom(value: unknown): Date | null {
  if (typeof value === 'number') {
    // Unix seconds — Daily's `event_ts` convention.
    return new Date(value * 1000);
  }
  if (typeof value === 'string' && value.length > 0) {
    return new Date(value);
  }
  return null;
}

/** What the route dispatches on. Six arms; the last is the ack-and-forget one. */
export type DailyWebhookEvent =
  | {
      readonly kind: 'participant.joined' | 'participant.left';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: string;
      /** The `u`/`g` + 32 hex claim, or `null` for a participant Balo cannot map. */
      readonly participantId: string | null;
      /** ⚠ May be an INVALID Date — see {@link instantFrom}. */
      readonly occurredAt: Date;
    }
  | {
      readonly kind: 'meeting.ended';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: string;
      readonly occurredAt: Date;
    }
  | {
      /** ⚠ NO ROOM. Resolved by `instanceId` = `meeting_recordings.id`. See the module docblock. */
      readonly kind: 'recording.started';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: null;
      readonly instanceId: string;
      /**
       * ⚠ DEVIATION FROM PLAN §7.3'S LITERAL UNION, MADE DELIBERATELY: OD-1's verified payload
       * table lists `recording_id` on `recording.started` too (alongside `instance_id`), and
       * `meetingRecordingsRepository.markStarted` (T2) REQUIRES a `dailyRecordingId` to stamp —
       * there is no other field on this event that could supply it. Omitting it here would make
       * T2 unimplementable. Required, same rule as `recording.ready-to-download`'s
       * `dailyRecordingId`: absent ⇒ `unhandled`.
       */
      readonly dailyRecordingId: string;
      /** From `start_ts` (unix seconds), else the envelope's `event_ts`, else `receivedAt`. */
      readonly startedAt: Date;
    }
  | {
      readonly kind: 'recording.ready-to-download';
      readonly eventId: string;
      readonly type: string;
      /** Present per docs; kept nullable because the fallback is the only thing that reads it. */
      readonly roomName: string | null;
      readonly dailyRecordingId: string;
      readonly durationSeconds: number | null;
      readonly startedAt: Date | null;
    }
  | {
      /** ⚠ NO `recording_id` in this payload — only `instance_id`, and even that is optional. */
      readonly kind: 'recording.error';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: string | null;
      readonly instanceId: string | null;
      readonly errorMessage: string | null;
    }
  | {
      /** A type Balo does not act on, or a handled type with no resolvable room/instance/id. */
      readonly kind: 'unhandled';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: string | null;
    };

export type ParseDailyWebhookResult =
  | { readonly ok: true; readonly event: DailyWebhookEvent }
  | { readonly ok: false; readonly reason: 'malformed_envelope' };

/**
 * Parse one verified delivery.
 *
 * @param receivedAt the instant the delivery arrived — the LAST-RESORT fallback when neither
 *   the event's own timestamp field nor the envelope's `event_ts` is usable. It is used only
 *   for a value that is ABSENT, never for one that is present and unparseable.
 */
export function parseDailyWebhookEvent(body: unknown, receivedAt: Date): ParseDailyWebhookResult {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed_envelope' };
  }

  const { id: eventId, type, event_ts: eventTs, payload } = parsed.data;
  const roomName = roomNameFrom(payload);
  const envelopeInstant = instantFrom(eventTs);

  if (!isHandledType(type)) {
    return { ok: true, event: { kind: 'unhandled', eventId, type, roomName } };
  }

  // ── BAL-473 — the three recording arms, resolved by instance/recording id, NOT by room. ──
  // These MUST run before the room-name gate below, which governs only the presence/meeting
  // arms — `recording.started` carries no room at all (see the module docblock).
  if (type === 'recording.started') {
    const instanceId = instanceIdFrom(payload);
    const dailyRecordingId = dailyRecordingIdFrom(payload);
    if (instanceId === null || dailyRecordingId === null) {
      // instanceId not a UUID (or absent) — it is our own id, a non-UUID is by definition not
      // ours. dailyRecordingId absent — T2 cannot stamp without it; see the union's docblock.
      return { ok: true, event: { kind: 'unhandled', eventId, type, roomName } };
    }
    return {
      ok: true,
      event: {
        kind: 'recording.started',
        eventId,
        type,
        roomName: null,
        instanceId,
        dailyRecordingId,
        startedAt: instantFrom(payload?.start_ts) ?? envelopeInstant ?? receivedAt,
      },
    };
  }

  if (type === 'recording.ready-to-download') {
    const dailyRecordingId = dailyRecordingIdFrom(payload);
    if (dailyRecordingId === null) {
      return { ok: true, event: { kind: 'unhandled', eventId, type, roomName } };
    }
    return {
      ok: true,
      event: {
        kind: 'recording.ready-to-download',
        eventId,
        type,
        roomName,
        dailyRecordingId,
        durationSeconds: durationFrom(payload),
        startedAt: instantFrom(payload?.start_ts),
      },
    };
  }

  if (type === 'recording.error') {
    return {
      ok: true,
      event: {
        kind: 'recording.error',
        eventId,
        type,
        roomName,
        instanceId: instanceIdFrom(payload),
        errorMessage: errorMsgFrom(payload),
      },
    };
  }

  // ⚠ EVERY REMAINING HANDLED TYPE (the presence/meeting arms) REQUIRES A ROOM. There is
  // nothing to apply it to otherwise, and refusing would make Daily retry a body that can
  // never resolve.
  if (roomName === null) {
    return { ok: true, event: { kind: 'unhandled', eventId, type, roomName } };
  }

  const occurredAt =
    instantFrom(payload?.[type === 'participant.left' ? 'left_at' : 'joined_at']) ??
    envelopeInstant ??
    receivedAt;

  if (type === 'meeting.ended') {
    return {
      ok: true,
      event: {
        kind: 'meeting.ended',
        eventId,
        type,
        roomName,
        occurredAt: instantFrom(payload?.end_ts) ?? envelopeInstant ?? receivedAt,
      },
    };
  }

  return {
    ok: true,
    event: {
      kind: type,
      eventId,
      type,
      roomName,
      participantId: participantIdFrom(payload),
      occurredAt,
    },
  };
}

/** Narrow a vendor `type` string to one Balo acts on. */
function isHandledType(type: string): type is HandledDailyEventType {
  return (HANDLED_DAILY_EVENT_TYPES as readonly string[]).includes(type);
}
