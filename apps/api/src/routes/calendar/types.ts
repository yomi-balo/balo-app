/** Frontend-facing calendar types (mirrored from web app _types/calendar.ts) */

export type CalendarConnectionStatus = 'connected' | 'sync_pending' | 'auth_error' | null;
export type CalendarProvider = 'google' | 'microsoft';

export interface SubCalendar {
  id: string;
  name: string;
  provider: CalendarProvider;
  primary: boolean;
  conflictChecking: boolean;
  color?: string;
}

export interface CalendarConnection {
  /**
   * BAL-396 fix round 2, Finding 6 — the CONNECTION's own provider, always known regardless
   * of `subCalendars` (it lives on the `calendar_connections` row itself). A SYNC_PENDING
   * connection has ZERO sub-calendars by construction, so `apps/web` cannot recover the
   * provider from `subCalendars[0]?.provider` in that state — this field is what closes that.
   */
  provider: CalendarProvider;
  status: CalendarConnectionStatus;
  providerEmail: string | null;
  lastSyncedAt: string | null;
  targetCalendarId: string | null;
  subCalendars: SubCalendar[];
}

/**
 * BAL-396 §8.2 — per-provider summary, the shape BAL-397's multi-connection UI will consume.
 */
export interface CalendarConnectionSummary {
  provider: CalendarProvider;
  status: CalendarConnectionStatus;
  providerEmail: string | null;
  lastSyncedAt: string | null;
  targetCalendarId: string | null;
  subCalendars: SubCalendar[];
}
