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
 */
import { z } from 'zod';

/** The three types this feature acts on. Everything else acks and does nothing. */
export const HANDLED_DAILY_EVENT_TYPES = [
  'participant.joined',
  'participant.left',
  'meeting.ended',
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

/** What the route dispatches on. Four arms; the fourth is the ack-and-forget one. */
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
      /** A type Balo does not act on, or a handled type with no resolvable room. */
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

  // ⚠ A HANDLED TYPE WITH NO ROOM DEGRADES TO `unhandled` rather than failing. There is nothing
  // to apply it to, and refusing would make Daily retry a body that can never resolve.
  if (roomName === null || !isHandledType(type)) {
    return { ok: true, event: { kind: 'unhandled', eventId, type, roomName } };
  }

  const envelopeInstant = instantFrom(eventTs);
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
