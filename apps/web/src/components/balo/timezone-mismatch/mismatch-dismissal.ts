const KEY_PREFIX = 'balo:tz-mismatch-kept:';

function dismissalKey(scheduleTimezone: string, deviceTimezone: string): string {
  return `${KEY_PREFIX}${scheduleTimezone}|${deviceTimezone}`;
}

/**
 * Whether the expert already answered the prompt for this exact pair of zones. A pair is
 * remembered per browser, so a later trip to a different zone prompts again. Storage that is
 * blocked or throws reads as "not answered".
 */
export function isMismatchAnswered(scheduleTimezone: string, deviceTimezone: string): boolean {
  try {
    return globalThis.localStorage.getItem(dismissalKey(scheduleTimezone, deviceTimezone)) !== null;
  } catch {
    return false;
  }
}

/** Remembers that the prompt for this pair of zones was answered. A throwing write is a no-op. */
export function markMismatchAnswered(scheduleTimezone: string, deviceTimezone: string): void {
  try {
    globalThis.localStorage.setItem(dismissalKey(scheduleTimezone, deviceTimezone), '1');
  } catch {
    // Storage is blocked or full: the prompt simply returns on the next load.
  }
}
