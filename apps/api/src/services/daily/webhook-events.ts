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

/** The eight types this feature acts on. Everything else acks and does nothing. */
export const HANDLED_DAILY_EVENT_TYPES = [
  'participant.joined',
  'participant.left',
  'meeting.ended',
  // BAL-473 — the recording arms. ⚠ `recording.started` carries NO `room_name`; see above.
  'recording.started',
  'recording.ready-to-download',
  'recording.error',
  // BAL-483 — the Batch Processor arms (post-call transcription). ⚠ NEITHER carries
  // `room_name`, `instance_id` OR `mtg_session_id` — verified against
  // docs.daily.co/reference/rest-api/webhooks/events/batch-processor-{job-finished,error}.md
  // on 2026-09-02. Both are resolved by `payload.id` (the batch job id, stamped on
  // `meeting_recordings.transcript_job_id` at submit) with `payload.input.recordingId` as a
  // fallback, so — like the recording arms — they must be parsed BEFORE the room-name gate.
  'batch-processor.job-finished',
  'batch-processor.error',
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

/** BAL-483 — `payload.preset`. Balo submits `'transcript'` only; anything else is not ours. */
function batchPresetFrom(payload: Record<string, unknown> | undefined): string | null {
  const preset = payload?.preset;
  return typeof preset === 'string' && preset.length > 0 ? preset : null;
}

/**
 * BAL-483 — `payload.input.recordingId` (either spelling) — DAILY's recording id, the
 * FALLBACK correlation handle.
 * ⚠ INFERRED, NOT SHOWN. `GET /batch-processor/:id` documents `input.recordingId`, but both
 * webhook examples use `sourceType: 'uri'`, so this field is unconfirmed on the webhook.
 * Absence is a first-class answer (`null`), never a refusal — the job id is the primary.
 */
function batchInputRecordingIdFrom(payload: Record<string, unknown> | undefined): string | null {
  const input = payload?.input;
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const id = record.recordingId ?? record.recording_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * BAL-483 — `payload.error`, the batch job's failure text.
 *
 * ⚠ FIX ROUND 1 — `?? payload?.errorMessage` was REMOVED. The plan's §2 vendor table and the
 * `daily-co` skill both pin the `batch-processor.error` payload as `id`, `preset`, `status`,
 * `input`, `error` (string), `output: {}` — `errorMessage` is not a documented spelling anywhere
 * for this event, unlike the genuinely dual-spelled fields elsewhere in this file
 * (`room`/`room_name`, `error_msg`/`errorMsg`, `start_ts`/`startTs`). An invented fallback
 * spelling is worse than no fallback: it invites a FUTURE Daily field that happens to share the
 * name to be silently misread as this one.
 */
function batchErrorFrom(payload: Record<string, unknown> | undefined): string | null {
  const msg = payload?.error;
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

/**
 * ⚠⚠ BAL-480 FIX ROUND 1 — `payload.start_ts` **IN EITHER SPELLING**, like every other field in
 * this file. It was snake_case only, which was the ONE exception here, and a silent one: this
 * value is the discriminator for `routes/daily/webhook.ts`'s room-fallback guard, and this
 * module's own header records that the field names could NOT be verified against docs.daily.co.
 * If Daily's real payload used the camelCase spelling, `startedAt` would be permanently `null`,
 * the guard would never arm, and nothing would say so. (The other half of that fix is on the
 * consuming side, which now logs every delivery that reaches the fallback with no start instant.)
 *
 * ⚠ RETURNS WHATEVER {@link instantFrom} RETURNS, INCLUDING AN INVALID DATE — the present-but
 * -unparseable case must stay distinguishable from the absent one all the way to the caller.
 */
function startTsFrom(payload: Record<string, unknown> | undefined): Date | null {
  return instantFrom(payload?.start_ts ?? payload?.startTs);
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
      /** ⚠ NO ROOM, NO INSTANCE. Resolved by `batchJobId`, falling back to `dailyRecordingId`. */
      readonly kind: 'batch-processor.job-finished';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: null;
      readonly batchJobId: string;
      /** `null` when Daily omitted it. Only `'transcript'` is ours. */
      readonly preset: string | null;
      /** From `payload.input.recordingId`. ⚠ May be `null` — see `batchInputRecordingIdFrom`. */
      readonly dailyRecordingId: string | null;
    }
  | {
      readonly kind: 'batch-processor.error';
      readonly eventId: string;
      readonly type: string;
      readonly roomName: null;
      readonly batchJobId: string;
      readonly preset: string | null;
      readonly dailyRecordingId: string | null;
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
 * BAL-483 — the two batch-processor arms, resolved by `payload.id` (the batch job id), NEVER
 * by room. Neither payload carries a room, an instance id or a session id. Extracted purely to
 * keep {@link parseDailyWebhookEvent}'s own Cognitive Complexity under SonarCloud's gate —
 * behaviour is unchanged from the inline form.
 */
function parseBatchProcessorEvent(
  type: 'batch-processor.job-finished' | 'batch-processor.error',
  eventId: string,
  roomName: string | null,
  payload: Record<string, unknown> | undefined
): ParseDailyWebhookResult {
  const batchJobId = typeof payload?.id === 'string' && payload.id.length > 0 ? payload.id : null;
  const preset = batchPresetFrom(payload);
  // ⚠ REFUSE ONLY ON A PRESENT-AND-WRONG PRESET. Balo submits no `summarize` jobs, but an
  // ops/manual one must be a CLEAN no-op rather than a delivery that resolves to nothing
  // noisily. An ABSENT preset is not evidence of anything, so it is let through.
  if (batchJobId === null || (preset !== null && preset !== 'transcript')) {
    return { ok: true, event: { kind: 'unhandled', eventId, type, roomName } };
  }
  const dailyRecordingId = batchInputRecordingIdFrom(payload);
  if (type === 'batch-processor.job-finished') {
    return {
      ok: true,
      event: {
        kind: 'batch-processor.job-finished',
        eventId,
        type,
        roomName: null,
        batchJobId,
        preset,
        dailyRecordingId,
      },
    };
  }
  return {
    ok: true,
    event: {
      kind: 'batch-processor.error',
      eventId,
      type,
      roomName: null,
      batchJobId,
      preset,
      dailyRecordingId,
      errorMessage: batchErrorFrom(payload),
    },
  };
}

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
        startedAt: startTsFrom(payload) ?? envelopeInstant ?? receivedAt,
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
        startedAt: startTsFrom(payload),
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

  // ── BAL-483 — the two batch-processor arms, resolved by `payload.id`, NEVER by room. Also
  // BEFORE the room-name gate below, for the same reason the recording arms are.
  if (type === 'batch-processor.job-finished' || type === 'batch-processor.error') {
    return parseBatchProcessorEvent(type, eventId, roomName, payload);
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
