import { formatInTimeZone } from 'date-fns-tz';
import { YOUR_MOVE_DATED_FACT } from './your-move-copy';
import type { YourMoveFactAt } from './your-move-view-types';

/**
 * Pure and client-safe: absolute dates on the Your move rail render in the viewer's device zone,
 * with the zone injected by the caller (`useViewerClock`).
 */

export function formatYourMoveDay(iso: string, timeZone: string): string {
  return formatInTimeZone(new Date(iso), timeZone, 'EEE d MMM');
}

export function formatYourMoveDayTime(iso: string, timeZone: string): string {
  return formatInTimeZone(new Date(iso), timeZone, 'EEE d MMM, h:mm aaa');
}

export function formatYourMoveFactAt(factAt: YourMoveFactAt, timeZone: string): string {
  return YOUR_MOVE_DATED_FACT[factAt.template](formatYourMoveDay(factAt.iso, timeZone));
}
