export const CALENDAR_EVENTS = {
  CONNECT_INITIATED: 'calendar_connect_initiated',
  DISCONNECT_INITIATED: 'calendar_disconnect_initiated',
  SUB_CALENDAR_TOGGLED: 'calendar_sub_calendar_toggled',
  TARGET_CALENDAR_SET: 'calendar_target_calendar_set',
  // BAL-233: Error state events
  FIX_PERMISSIONS_CLICKED: 'calendar_fix_permissions_clicked',
  RECONNECT_CLICKED: 'calendar_reconnect_clicked',
  SYNC_PENDING_RESOLVED: 'calendar_sync_pending_resolved',
  O365_GUIDANCE_SHOWN: 'calendar_o365_guidance_shown',
  O365_GUIDANCE_CONTINUED: 'calendar_o365_guidance_continued',
  O365_GUIDANCE_CANCELLED: 'calendar_o365_guidance_cancelled',
  O365_WAITING_TRY_AGAIN: 'calendar_o365_waiting_try_again',
  SESSION_EXPIRED_TRY_AGAIN: 'calendar_session_expired_try_again',
  CONNECTING_TIMEOUT: 'calendar_connecting_timeout',
} as const;

export interface CalendarEventMap {
  [CALENDAR_EVENTS.CONNECT_INITIATED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.DISCONNECT_INITIATED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.SUB_CALENDAR_TOGGLED]: {
    sub_calendar_id: string;
    conflict_checking: boolean;
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.TARGET_CALENDAR_SET]: {
    target_calendar_id: string;
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.FIX_PERMISSIONS_CLICKED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.RECONNECT_CLICKED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.SYNC_PENDING_RESOLVED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.O365_GUIDANCE_SHOWN]: Record<string, never>;
  [CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED]: Record<string, never>;
  [CALENDAR_EVENTS.O365_GUIDANCE_CANCELLED]: Record<string, never>;
  [CALENDAR_EVENTS.O365_WAITING_TRY_AGAIN]: Record<string, never>;
  [CALENDAR_EVENTS.SESSION_EXPIRED_TRY_AGAIN]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.CONNECTING_TIMEOUT]: {
    provider: 'google' | 'microsoft';
  };
}

// ── Server-side events ──────────────────────────────────────────

/**
 * ⚠ BAL-396 FIX ROUND — `TOKEN_REFRESHED`, `WEBHOOK_RECEIVED` and `RELINK_URL_GENERATED`
 * (Cronofy-era events) were REMOVED here, not merely left unemitted. They named concepts
 * BAL-396 deleted outright: Balo no longer holds or refreshes provider tokens (Apiroc's
 * pointer model, apiroc skill Constraint 1), the Cronofy webhook route these events were
 * emitted from is gone (BAL-468 owns its Apiroc-shaped replacement), and Cronofy's relink-URL
 * concept has no Apiroc counterpart. Keeping them would have pinned a permanently-zero-emitter
 * "as current" against the exact-key-set guard in `calendar.test.ts`.
 */
export const CALENDAR_SERVER_EVENTS = {
  OAUTH_COMPLETED: 'calendar_oauth_completed',
  OAUTH_FAILED: 'calendar_oauth_failed',
  DISCONNECTED: 'calendar_disconnected',
  AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
  // BAL-233: Error state events
  SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
  // BAL-235: Date overrides (time off) events
  AVAILABILITY_OVERRIDE_CREATED: 'availability_override_created',
  AVAILABILITY_OVERRIDE_DELETED: 'availability_override_deleted',
  // BAL-396 (ADR-1021 amendment 18 Aug 2026 §6) — Apiroc credential-health lifecycle.
  CREDENTIALS_REVOKED: 'calendar_credentials_revoked',
  RECONNECT_RESOLVED: 'calendar_reconnect_resolved',
} as const;

export interface CalendarServerEventMap {
  [CALENDAR_SERVER_EVENTS.OAUTH_COMPLETED]: {
    provider: string;
    status: 'connected' | 'sync_pending';
    distinct_id: string;
  };
  /**
   * BAL-396 §6 — `error_message` (raw `err.message`, which under Apiroc can carry vendor
   * wire text) is REPLACED by `error_code`, a bounded code from
   * `routes/calendar/auth.ts::classifyCallbackError`. Never widen this back to a raw message.
   */
  [CALENDAR_SERVER_EVENTS.OAUTH_FAILED]: {
    error_code: string;
    provider?: 'google' | 'microsoft';
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.DISCONNECTED]: {
    /** Absent = disconnect-all (every provider, the whole-account backstop path). */
    provider?: 'google' | 'microsoft';
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.AVAILABILITY_CACHE_REBUILT]: {
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.SYNC_PENDING_AUTO_RESOLVED]: {
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_CREATED]: {
    /** Inclusive day count of the block (single day = 1). */
    duration_days: number;
    has_label: boolean;
    /** = expertProfileId. */
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_DELETED]: {
    /** = expertProfileId. */
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.CREDENTIALS_REVOKED]: {
    provider: 'google' | 'microsoft';
    /**
     * The silent-breakage metric BAL-396 asks for: did the PROBE catch it, or a booking?
     *
     * ⚠ `'health_probe'` ONLY, as shipped (BAL-396 fix round) — `applyCredentialFailure`
     * has exactly one production caller (`jobs/calendar-health-probe.ts`), which always
     * passes `'health_probe'`. Widen back to `'health_probe' | 'data_call'` the same PR
     * that adds a booking-path caller catching an `ApirocError` directly — not before, or
     * this metric is uncomputable again.
     */
    detected_by: 'health_probe';
    /** = expertProfileId. */
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.RECONNECT_RESOLVED]: {
    provider: 'google' | 'microsoft';
    /** = expertProfileId. */
    distinct_id: string;
  };
}

/**
 * BAL-396 §10.4/§10.5 — narrows `calendar_connections.provider` (a plain `string` column) to
 * this map's literal union, WITHOUT any call site having to name a provider literal.
 *
 * Why this exists here rather than at the call site: `services/calendar/*.ts` and
 * `jobs/*.ts` are provider-AGNOSTIC by ADR-1021 (amendment 2026-08-15) and are guarded by
 * `apps/api/src/invariants/sync-token-parity.test.ts` Scan B, which fails the build the moment
 * either directory's source text contains the substring `'google'` or `'microsoft'` — even
 * inside a type assertion. `credential-status.ts` (and, from BAL-396's next pass, the health
 * probe) need a `'google' | 'microsoft'` value to call `trackServer` with the payload shape
 * above; importing this guard keeps the literal out of their source text entirely.
 *
 * Returns `undefined` for anything else rather than asserting — defensive, since only two
 * providers are ever written to the column in practice, but this boundary does not assume it.
 */
export function toCalendarEventProvider(provider: string): 'google' | 'microsoft' | undefined {
  if (provider === 'google' || provider === 'microsoft') return provider;
  return undefined;
}
