/**
 * BAL-134 / BAL-654 — "HAS THIS PROMISE ALREADY BEEN DECIDED?" — ONE DEFINITION, THREE CONSUMERS.
 *
 * ⚠⚠ THE DEDUPE KEY FOLDS ONLY ONTO **PENDING** ROWS (`scheduled_notifications`' partial unique
 * index), so once a promise has fired the next sweep tick's `first_wins` call schedules a fresh
 * one with a fire time in the past, and it fires on the next dispatch tick. Left alone, a
 * condition that keeps holding (the expert still alone in the room) re-sends every minute. The
 * key's HISTORY is what says "once per meeting", so every arm site and every recheck of a
 * once-per-meeting promise reads it through this helper.
 *
 * A key is DECIDED when any other row for it:
 *   · was published, is claimed (a send in flight) or failed terminally (unless `failedRearms`); or
 *   · was skipped for a reason that is NOT in `rearmableReasons`.
 *
 * A skip is re-armable when the world can legitimately change back to "send it" (the expert left
 * and returned, the venue became ready). A `pending` or `cancelled` row decides nothing.
 */
import { scheduledNotificationsRepository, type ScheduledNotification } from '@balo/db';

const DECIDING_STATUSES: ReadonlySet<string> = new Set(['published', 'claimed', 'failed']);
const IN_FLIGHT_OR_SENT_STATUSES: ReadonlySet<string> = new Set(['published', 'claimed']);

export interface ScheduledKeyDecidedOptions {
  /**
   * A terminally `failed` row decides nothing, so the key may be armed again. For a promise whose
   * silence would be worse than a repeat — the ops expert-absent alert. Every other key keeps
   * `failed` final.
   */
  readonly failedRearms?: boolean;
}

type HistoryRow = Pick<ScheduledNotification, 'id' | 'status' | 'skipReason'>;

/**
 * Pure. `excludeId` is the row asking — a recheck must not read its own claim as a decision.
 */
export function scheduledKeyDecided(
  rows: readonly HistoryRow[],
  rearmableReasons: readonly string[],
  excludeId?: string,
  options: ScheduledKeyDecidedOptions = {}
): boolean {
  const decidingStatuses =
    options.failedRearms === true ? IN_FLIGHT_OR_SENT_STATUSES : DECIDING_STATUSES;
  return rows.some((row) => {
    if (row.id === excludeId) {
      return false;
    }
    if (decidingStatuses.has(row.status)) {
      return true;
    }
    return (
      row.status === 'skipped' &&
      (row.skipReason === null || !rearmableReasons.includes(row.skipReason))
    );
  });
}

/** {@link scheduledKeyDecided} over the key's stored history. */
export async function isScheduledKeyDecided(
  key: string,
  rearmableReasons: readonly string[],
  excludeId?: string,
  options?: ScheduledKeyDecidedOptions
): Promise<boolean> {
  return scheduledKeyDecided(
    await scheduledNotificationsRepository.findByDedupeKey(key),
    rearmableReasons,
    excludeId,
    options
  );
}
