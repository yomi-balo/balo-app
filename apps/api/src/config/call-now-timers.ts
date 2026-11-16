/**
 * BAL-649 (decisions 3 & 8) — THE ONLY PLACE THE TWO CALL NOW RING WINDOWS ARE READ FROM
 * `process.env`.
 *
 * ⚠ WHY IT IS HERE AND NOT IN `@balo/shared/meetings`: that subpath is client-reachable, so a
 * `process.env` read there would ship into a browser bundle. The shared module holds the typed
 * defaults (`CALL_NOW_RING_MS`, `CALL_NOW_RING_SMS_MS`); this module is the boundary that turns
 * the environment into one of those values. Only `apps/api` imports it.
 *
 * ⚠ THE WINDOWS ARE WHOLE SECONDS, not the whole minutes `MeetingTimers` uses, which is why they
 * live apart from `meeting-timers.ts`. A rejected override logs at `warn` naming the variable and
 * falls back to the shipped default; a malformed Railway variable must never crash-loop the API.
 *
 * ⚠ READ AT CALL TIME, never at import time, so a test can set the variables first.
 */
import { CALL_NOW_RING_MS, CALL_NOW_RING_SMS_MS, type CallRingReach } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('call-now-timers-config');

const MS_PER_SECOND = 1000;

export interface CallNowRingWindows {
  /** The ring window when the callee is reached in the app. */
  readonly appMs: number;
  /** The ring window when the callee is also reached by SMS. */
  readonly smsMs: number;
}

const WINDOW_OVERRIDES: ReadonlyArray<{
  readonly field: keyof CallNowRingWindows;
  readonly variable: string;
  readonly defaultMs: number;
}> = [
  { field: 'appMs', variable: 'CALL_NOW_RING_SECONDS', defaultMs: CALL_NOW_RING_MS },
  { field: 'smsMs', variable: 'CALL_NOW_RING_SMS_SECONDS', defaultMs: CALL_NOW_RING_SMS_MS },
];

/** A positive whole number of seconds, or `null`. */
function parseSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,7}$/.test(trimmed)) {
    return null;
  }
  const seconds = Number(trimmed);
  return seconds > 0 ? seconds : null;
}

/** The two ring windows, with any valid env overrides applied. */
export function resolveCallNowRingWindows(): CallNowRingWindows {
  const resolved: { appMs: number; smsMs: number } = {
    appMs: CALL_NOW_RING_MS,
    smsMs: CALL_NOW_RING_SMS_MS,
  };

  for (const { field, variable, defaultMs } of WINDOW_OVERRIDES) {
    const raw = process.env[variable];
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    const seconds = parseSeconds(raw);
    if (seconds === null) {
      log.warn(
        { variable, defaultMs },
        'Call now ring window override is not a positive whole number of seconds — using the default'
      );
      continue;
    }
    resolved[field] = seconds * MS_PER_SECOND;
  }
  return resolved;
}

/** When a ring started at `now` and reaching the callee by `reachedBy` stops ringing. */
export function ringExpiresAt(
  now: Date,
  reachedBy: CallRingReach,
  windows: CallNowRingWindows
): Date {
  const windowMs = reachedBy === 'sms' ? windows.smsMs : windows.appMs;
  return new Date(now.getTime() + windowMs);
}
