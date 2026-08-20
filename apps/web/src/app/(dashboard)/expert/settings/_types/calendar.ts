/**
 * The REAL vocabulary, straight off `calendar_connections.credential_status`
 * (`CALENDAR_CREDENTIAL_STATUSES`, packages/db/src/schema/calendar.ts:33).
 *
 * ⚠ BAL-397 removed `toLegacyStatus`, the Cronofy-era adapter that collapsed this to
 * `connected | sync_pending | auth_error`. `EXPIRED` and `REVOKED` render ONE shared
 * "Reconnect needed" UX (apiroc skill: "build no distinct UX for the two" — a user-initiated
 * revoke surfaces as EXPIRED anyway), but they stay DISTINCT on the wire so the difference
 * remains observable in logs and analytics. Do not re-collapse them at any boundary.
 */
export type CalendarCredentialStatus = 'ACTIVE' | 'SYNC_PENDING' | 'EXPIRED' | 'REVOKED';
export type CalendarProvider = 'google' | 'microsoft';

export interface SubCalendar {
  id: string;
  name: string;
  provider: CalendarProvider;
  primary: boolean;
  conflictChecking: boolean;
  color?: string;
}

/**
 * One live connection for one provider. An expert holds 0..2 of these
 * (unique index `cal_conn_expert_provider_idx`, partial on `deleted_at IS NULL`).
 *
 * ⚠ This mirror does NOT import from `@balo/db`. A type-only import would erase, but this file
 * is pulled into the client graph and a later hand adding a value import here breaks
 * `next build` with `Can't resolve 'tls'` (repo memory:
 * `reference_balo_db_client_bundle_footgun`). Redeclaring four string literals is the cheap,
 * safe side of that trade.
 */
export interface CalendarConnection {
  /** ⚠ The CONNECTION's own provider. A SYNC_PENDING connection has ZERO sub-calendars by
   *  construction, so `subCalendars[0]?.provider` can never recover it. Read it here. */
  provider: CalendarProvider;
  credentialStatus: CalendarCredentialStatus;
  providerEmail: string | null;
  lastSyncedAt: string | null;
  targetCalendarId: string | null;
  subCalendars: SubCalendar[];
}
