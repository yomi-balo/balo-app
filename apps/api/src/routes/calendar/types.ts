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
  status: CalendarConnectionStatus;
  providerEmail: string | null;
  lastSyncedAt: string | null;
  targetCalendarId: string | null;
  subCalendars: SubCalendar[];
}
