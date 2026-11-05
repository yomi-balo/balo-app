const KEY_PREFIX = 'balo:tz-mismatch-kept:';

/** How long a remembered Keep silences the prompt for its pair of zones. */
export const MISMATCH_KEEP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function dismissalKey(scheduleTimezone: string, deviceTimezone: string): string {
  return `${KEY_PREFIX}${scheduleTimezone}|${deviceTimezone}`;
}

/**
 * Whether the expert answered the prompt for this exact pair of zones within the last
 * {@link MISMATCH_KEEP_TTL_MS}. The stored value is the answer time in epoch milliseconds; the
 * legacy value `'1'`, anything unparseable and a time in the future all read as "not answered".
 * A pair is remembered per browser, so a later trip to a different zone prompts again. Storage
 * that is blocked or throws reads as "not answered".
 */
export function isMismatchAnswered(
  scheduleTimezone: string,
  deviceTimezone: string,
  now: number = Date.now()
): boolean {
  try {
    const stored = globalThis.localStorage.getItem(dismissalKey(scheduleTimezone, deviceTimezone));
    if (stored === null || !/^\d{1,16}$/.test(stored)) return false;
    const age = now - Number(stored);
    return age >= 0 && age < MISMATCH_KEEP_TTL_MS;
  } catch {
    return false;
  }
}

/** Remembers that the prompt for this pair of zones was answered at `now`. A throwing write is a no-op. */
export function markMismatchAnswered(
  scheduleTimezone: string,
  deviceTimezone: string,
  now: number = Date.now()
): void {
  try {
    globalThis.localStorage.setItem(dismissalKey(scheduleTimezone, deviceTimezone), String(now));
  } catch {
    // Storage is blocked or full: the prompt simply returns on the next load.
  }
}
