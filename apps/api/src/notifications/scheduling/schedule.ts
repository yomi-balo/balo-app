import {
  scheduledNotificationsRepository,
  type ScheduleOutcome,
  type ScheduledNotificationMode,
  type ScheduledNotificationPayload,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { EventPayloadMap, NotificationEvent } from '../events.js';

const logger = createLogger('notification-scheduling');

/**
 * The repository's optional transaction executor, derived from its own signature rather
 * than imported: `DbExecutor` lives in `@balo/db`'s internal `repositories/_shared/` and is
 * not part of the package's public surface. Deriving it keeps the two in lockstep with no
 * new export.
 *
 * PASSING ONE IS THE POINT (ADR-1047 R8). An `apps/api` consumer that writes the schedule
 * row INSIDE its own domain transaction gets a real outbox — the promise and the fact that
 * warranted it commit together or not at all — which is why the fire-and-forget durability
 * gap that applies to a future web-side schedule does not apply to API-side callers.
 */
export type ScheduleExecutor = NonNullable<
  Parameters<typeof scheduledNotificationsRepository.schedule>[1]
>;

export interface ScheduleOptions {
  /**
   * CALLER-OWNED dedup handle AND cancel handle. Required, and non-blank — the caller is
   * the only party that knows what makes two schedules "the same one".
   */
  key: string;
  /** Absolute fire time. Exactly one of `at` / `delayMs`. */
  at?: Date;
  /** Relative fire time, in milliseconds from now. Exactly one of `at` / `delayMs`. */
  delayMs?: number;
  /** Defaults to `first_wins` — a duplicate schedule is a no-op, not a silent move. */
  mode?: ScheduledNotificationMode;
  /**
   * Name of a guard in `SCHEDULED_RECHECKS`. Omit only for a genuinely unconditional
   * reminder: a cancel can always be missed, so anything CONDITIONAL must register one
   * (ADR Decision 5 — the fire-time recheck is the authority, cancellation is the
   * optimisation).
   */
  recheck?: string;
}

export interface ScheduleResult {
  outcome: ScheduleOutcome;
}

/**
 * A `scheduleNotification` call that could never be valid — a blank key, or neither/both of
 * `at` and `delayMs`. THESE ARE PROGRAMMING ERRORS, NOT RUNTIME CONDITIONS, so they throw
 * rather than returning a result the caller might ignore. (A `scheduledFor` in the PAST is
 * NOT one of them — see `resolveScheduledFor`.)
 */
export class InvalidScheduleOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleOptionsError';
  }
}

/**
 * Resolve the absolute fire time from exactly one of `at` / `delayMs`.
 *
 * ⚠ A TIME IN THE PAST IS ALLOWED AND IS NOT CLAMPED. The next tick simply fires it. That
 * is the correct behaviour for a schedule computed from a past anchor, or written during a
 * backlog — silently moving it to "now + 0" and silently rejecting it are both worse, and
 * the second would lose a notification that was genuinely owed.
 */
function resolveScheduledFor(options: ScheduleOptions, now: Date): Date {
  const hasAt = options.at !== undefined;
  const hasDelay = options.delayMs !== undefined;

  if (hasAt === hasDelay) {
    throw new InvalidScheduleOptionsError(
      'scheduleNotification requires exactly one of `at` or `delayMs`'
    );
  }

  if (options.at !== undefined) {
    if (Number.isNaN(options.at.getTime())) {
      throw new InvalidScheduleOptionsError('scheduleNotification `at` is not a valid Date');
    }
    return options.at;
  }

  const delayMs = options.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new InvalidScheduleOptionsError(
      'scheduleNotification `delayMs` must be a finite, non-negative number'
    );
  }
  return new Date(now.getTime() + delayMs);
}

/**
 * Event payload interfaces carry no index signature, so TypeScript will not structurally
 * widen one to `Record<string, unknown>` — the jsonb column's STORED shape — even though
 * every notification payload already is a plain JSON object at runtime (ids, numbers, and
 * ISO timestamp STRINGS; never a `Date`, per the schema's jsonb note). Round-tripping
 * through `JSON.parse(JSON.stringify(...))` would pay a runtime cost for a compile-time
 * problem, so the conversion is one localised assertion with this comment attached.
 */
function toStoredPayload(payload: object): ScheduledNotificationPayload {
  return payload as ScheduledNotificationPayload;
}

/**
 * Every notification event EXCEPT the ones whose payload contract forbids persisting it for
 * the life of a promise.
 *
 * ⚠ THIS IS NOT AN AUTHORIZATION ALLOWLIST, and must not be read as one. ADR Decision 10 is
 * explicit that a second in-process gate would be theatre — `apps/api` is fully trusted and
 * can already `publish` anything, including everything excluded here. This is the PAYLOAD
 * contract from Decision 4 made mechanical instead of aspirational:
 *
 * > "No PII beyond what an event payload already carries. A scheduled payload sits in a
 * > Postgres table for the life of the promise; the `email_address` recipient path's
 * > deliberate PII-in-payload exception must be re-justified per consumer before it is
 * > scheduled."
 *
 * Nothing enforced that. `expert.referral_invited` is the ONLY payload in `EventPayloadMap`
 * carrying a `recipientEmail` — a raw EXTERNAL address, for someone who is not a Balo user
 * and has no row to erase — and scheduling it compiled today, which would have parked that
 * address in `scheduled_notifications.payload` for up to 30 days with terminal-row purge
 * deferred (ADR OQ1).
 *
 * A future consumer that genuinely needs to defer an external-recipient email removes it
 * from this `Exclude` DELIBERATELY, having re-justified the exception and answered retention
 * — which is exactly what Decision 4 asks for, and exactly what a one-line type change makes
 * unavoidable rather than forgettable.
 */
export type SchedulableNotificationEvent = Exclude<NotificationEvent, 'expert.referral_invited'>;

/**
 * DEFER A PUBLISH: "when this fires, publish `event` with `payload` — once, unless the
 * reason has gone away." (BAL-420 / ADR-1047.)
 *
 * WHAT IS SCHEDULED IS THE EVENT, NOT THE DELIVERY (Decision 2). At fire time the dispatch
 * tick calls the ordinary `notificationEvents.publish(event, payload)` and the engine runs
 * exactly as it does today — so recipient resolution, preference checks and fan-out are all
 * re-resolved at FIRE time rather than frozen at schedule time, and every `NotificationRule`
 * stays truthfully `timing: 'immediate'`. There is ONE cancel key per promise instead of one
 * per (template × recipient).
 *
 * NO AUTHORIZATION GATE, DELIBERATELY (Decision 10). `apps/api` is fully trusted and can
 * already publish anything, so a second in-process allowlist would be theatre. The one
 * narrowing on the event union — `SchedulableNotificationEvent` — is the PAYLOAD contract
 * (Decision 4), not permission: what needs encoding for a 30-day promise is that the payload
 * is self-sufficient at fire time and carries no PII beyond what an event payload already
 * does. The separate question of what `apps/web` may schedule through a future HTTP seam is
 * answered by `WebSchedulableNotificationEvent` (currently `never`), not here.
 *
 * ⚠ NOT AN HTTP SURFACE, AND `cancel` NEVER WILL BE (Decision 11).
 *
 * @returns the fold outcome — `scheduled` (a new promise), `already_pending` (`first_wins`
 * found a live one and left it untouched) or `replaced` (`replace_pending` superseded it).
 */
export async function scheduleNotification<E extends SchedulableNotificationEvent>(
  event: E,
  payload: EventPayloadMap[E],
  options: ScheduleOptions,
  exec?: ScheduleExecutor
): Promise<ScheduleResult> {
  if (options.key.trim().length === 0) {
    throw new InvalidScheduleOptionsError('scheduleNotification requires a non-empty `key`');
  }

  const scheduledFor = resolveScheduledFor(options, new Date());
  const mode: ScheduledNotificationMode = options.mode ?? 'first_wins';

  const { outcome } = await scheduledNotificationsRepository.schedule(
    {
      dedupeKey: options.key,
      event,
      payload: toStoredPayload(payload),
      scheduledFor,
      mode,
      recheck: options.recheck ?? null,
    },
    exec
  );

  logger.info(
    {
      key: options.key,
      event,
      scheduledFor: scheduledFor.toISOString(),
      mode,
      recheck: options.recheck ?? null,
      outcome,
    },
    'Scheduled notification accepted'
  );

  return { outcome };
}

/**
 * Void the pending promise for `key`.
 *
 * ⚠ IN-PROCESS ONLY — THIS NEVER GETS AN HTTP ROUTE (ADR-1047 Decision 11). Cancel is a
 * HIGHER-PRIVILEGE operation than publish: a web-callable cancel-by-key could suppress the
 * alert whose entire purpose is to tell Balo that an expert did not show up for a paid
 * consultation, and dedup keys are deterministic and derived from entity ids, so silencing a
 * specific victim's alert would need no enumeration. It is also not NEEDED: every
 * condition-voiding fact in the consumer set — the expert joined, the client joined, the
 * proposal was answered, the messages were read — is something `apps/api` learns
 * server-side, so cancellation is a consequence the API draws from a fact it already holds.
 * Where the fact originates in `apps/web`, the consumer routes it as an ordinary domain
 * event (which `apps/web` can already publish) and cancels API-side.
 *
 * @returns how many rows were cancelled. **Zero is NORMAL, not an error** — nothing was
 * scheduled, or the promise already fired. A CLAIMED row is deliberately not cancellable;
 * the fire-time recheck is the authority for that window (Decision 5).
 */
export async function cancelScheduledNotification(
  key: string,
  exec?: ScheduleExecutor
): Promise<number> {
  const cancelled = await scheduledNotificationsRepository.cancel(key, exec);
  logger.info({ key, cancelled }, 'Scheduled notification cancel applied');
  return cancelled;
}
