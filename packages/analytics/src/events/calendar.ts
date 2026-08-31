import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

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
  // BAL-498 — the Calendar page (ADR-1053).
  VIEWED: 'calendar_viewed',
  JOIN_CLICKED: 'calendar_join_clicked',
  EDIT_AVAILABILITY_CLICKED: 'calendar_edit_availability_clicked',
  // BAL-512 — the Calendar page's CONNECTION funnel (distinct from `CONNECT_INITIATED`, which
  // fires when the OAuth round trip actually starts in Settings — this is the click-through that
  // precedes it) and its week-navigation behaviour.
  CONNECT_CTA_CLICKED: 'calendar_connect_cta_clicked',
  WEEK_NAVIGATED: 'calendar_week_navigated',
} as const;

export interface CalendarEventMap {
  [CALENDAR_EVENTS.VIEWED]: {
    view: 'week' | 'agenda';
    /** How this view became active — the viewport default vs a deliberate switch. */
    source: 'initial' | 'switch';
    /**
     * BAL-512 — signed weeks between the VISIBLE week and the current week (0 = this week,
     * -1 = last week, +2 = two weeks ahead). This event fires once per view per page lifecycle
     * (`viewedRef`), so this is the week the expert LANDED on: a deep-linked `?week=` load is
     * no longer indistinguishable from a this-week load, which is what makes an "anchor" session
     * (offset 0, zero `calendar_week_navigated`) separable from an "explorer" one.
     *
     * Bounded to roughly [-53, +53] — `page.tsx` clamps `?week=` to ±365 days
     * (`MAX_WEEK_OFFSET_DAYS`) before it ever reaches the shell. Not an unbounded integer.
     */
    week_offset: number;
  };
  [CALENDAR_EVENTS.JOIN_CLICKED]: {
    view: 'week' | 'agenda';
    context_type: MeetingContextTypeWithHolder;
    /** Signed minutes to scheduled start — negative once the meeting has begun. */
    minutes_to_start: number;
  };
  [CALENDAR_EVENTS.EDIT_AVAILABILITY_CLICKED]: {
    /**
     * The two AVAILABILITY-UPKEEP affordances on the Calendar page.
     *
     * ⚠ BAL-512 REMOVED `'empty_state_no_calendar'` from this union. That CTA was a CONNECTION
     * intent wearing an upkeep event's name, which conflated the two funnels BAL-498 exists to
     * measure; it now fires `calendar_connect_cta_clicked { source: 'empty_state' }`. Do not
     * re-add it here.
     *
     * ⚠ The two survivors point at DIFFERENT destinations — `'header'` at
     * `/expert/settings?tab=schedule`, `'not_configured_note'` at
     * `/expert/settings?tab=schedule&setup=availability`. They share an INTENT, not a URL.
     */
    source: 'header' | 'not_configured_note';
  };
  [CALENDAR_EVENTS.CONNECT_CTA_CLICKED]: {
    /**
     * WHICH connect affordance on the Calendar page was clicked: the full-page "no calendar
     * connected" empty state (shown only when there are also no meetings), or the inline warning
     * banner that appears alongside real bookings. Both point at
     * `/expert/settings?tab=schedule&setup=calendar`.
     *
     * ⚠ DISTINCT FROM `CONNECT_INITIATED` (BAL-397), which fires when the OAuth round trip
     * actually starts in Settings. This is the click-through that PRECEDES it — the two are the
     * first two steps of one funnel, not duplicates. The value unions do not overlap.
     */
    source: 'empty_state' | 'banner';
  };
  [CALENDAR_EVENTS.WEEK_NAVIGATED]: {
    /**
     * Names the DESTINATION relative to the week the expert was ON — NOT which button was
     * pressed — except that landing on the CURRENT week is always `'today'`. `WeekNav` reports a
     * destination day key only and BAL-512 deliberately keeps it that way, so the shell has no
     * affordance identity to report. `'today'` therefore means "returned to this week", whether
     * via the Today button or a Previous/Next click that happened to land there.
     *
     * ⚠ `'previous'`/`'next'` are relative to the VISIBLE week, not the current one: from `+3`,
     * a Previous click to `+2` is `'previous'` even though `+2` is still ahead of this week.
     *
     * ⚠ INVARIANT: `direction === 'today'` ⟺ `week_offset === 0`. The Today button is
     * `aria-disabled` + `pointer-events-none` whenever the visible week already contains today
     * (`week-nav.tsx`), so it can only ever fire with offset 0; and any Previous/Next landing on
     * offset 0 is reported as `'today'` by the same rule. `calendar-shell.test.tsx` pins both
     * halves.
     */
    direction: 'previous' | 'next' | 'today';
    /**
     * Signed weeks between the DESTINATION week and the current week — the same definition and
     * the same helper as `calendar_viewed.week_offset`, so the two are directly comparable in a
     * funnel.
     */
    week_offset: number;
  };
  [CALENDAR_EVENTS.CONNECT_INITIATED]: {
    provider: 'google' | 'microsoft';
    /** BAL-397 — WHICH affordance started this round trip. Optional so no existing call site
     *  breaks and no constant key changes. 'add_another' is the metric that tells us whether
     *  the multi-provider affordance this ticket built is actually used; 'reopen_window' is
     *  the card's "Re-open window" retry while an attempt is still in flight (T11), separated
     *  so a re-opened window is not counted as a fresh first attempt. */
    source?: 'first_connect' | 'add_another' | 'reconnect' | 'fix_permissions' | 'reopen_window';
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
 *
 * ⚠ BAL-235's date-override (time off) events (`AVAILABILITY_OVERRIDE_CREATED` /
 * `_DELETED`) MOVED OUT of this constant by BAL-416, to
 * `AVAILABILITY_SERVER_EVENTS.OVERRIDE_CREATED` / `.OVERRIDE_DELETED` in
 * `./availability.ts`. They never belonged here: Balo-side scheduling, not calendar-vendor
 * lifecycle, and the only members of this constant without a `calendar_` prefix. The wire
 * values are UNCHANGED (`availability_override_created` / `_deleted`) — do not re-add them
 * here.
 */
export const CALENDAR_SERVER_EVENTS = {
  OAUTH_COMPLETED: 'calendar_oauth_completed',
  OAUTH_FAILED: 'calendar_oauth_failed',
  DISCONNECTED: 'calendar_disconnected',
  AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
  // BAL-233: Error state events
  SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
  // BAL-396 (ADR-1021 amendment 18 Aug 2026 §6) — Apiroc credential-health lifecycle.
  CREDENTIALS_REVOKED: 'calendar_credentials_revoked',
  RECONNECT_RESOLVED: 'calendar_reconnect_resolved',
  // BAL-468 — the daily calendar-subscription monitor's non-zero-arm alert.
  SUBSCRIPTION_LAPSE_DETECTED: 'calendar_subscription_lapse_detected',
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
  [CALENDAR_SERVER_EVENTS.SUBSCRIPTION_LAPSE_DETECTED]: {
    /** Live subscriptions expiring inside SUBSCRIPTION_EXPIRY_ALERT_MS. */
    expiring_count: number;
    /** Live subscriptions the vendor has never confirmed (past the 2h grace). */
    unconfirmed_count: number;
    /** Live ACTIVE connections with ZERO live subscriptions — the silent-expiry shape. */
    unsubscribed_connection_count: number;
    /** Platform-level sweep — precedent 'system:fx-display' (jobs/fx-display-rate-sweep.ts). */
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
