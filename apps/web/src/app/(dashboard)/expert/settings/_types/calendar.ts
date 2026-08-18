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
   * of `subCalendars` (it lives on the connection row itself, not derived from sub-calendars).
   * A SYNC_PENDING connection has ZERO sub-calendars by construction, so
   * `subCalendars[0]?.provider` cannot be trusted to recover the provider in that state — this
   * field is what closes that (`calendar-tab.tsx`'s `handleFixPermissions`).
   */
  provider: CalendarProvider;
  status: CalendarConnectionStatus;
  providerEmail: string | null;
  lastSyncedAt: string | null;
  targetCalendarId: string | null;
  subCalendars: SubCalendar[];
}
