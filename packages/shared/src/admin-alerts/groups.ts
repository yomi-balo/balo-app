/**
 * BAL-548 / ADR-1055 — the pending-actions queue's GROUP vocabulary.
 *
 * `packages/shared` imports NO db, no `node:crypto`, no React, no I/O — the standing rule
 * stated in `./detail.ts`'s header.
 */

/**
 * The four TILE groups on Home — the queue's filter control (ADR-1055; `admin-home.jsx:636`).
 * ⚠ FIVE GROUPS EXIST, FOUR HAVE TILES. See {@link AdminAlertGroup}.
 */
export const ADMIN_ALERT_GROUPS = {
  marketplace: { label: 'Marketplace', hint: 'Applications, reviews, project triage' },
  money: { label: 'Money', hint: 'Receivables, reloads, disputes, payouts, unbilled sessions' },
  capture: { label: 'Capture', hint: 'Recording, transcription, recap' },
  meetings: { label: 'Meetings & calendar', hint: 'Calendar sync, amends, cancellations' },
} as const;

/** Tile order, left to right. The grid is data-driven off this. */
export const ADMIN_ALERT_GROUP_ORDER = ['marketplace', 'money', 'capture', 'meetings'] as const;
export type AdminAlertTileGroup = (typeof ADMIN_ALERT_GROUP_ORDER)[number];

/**
 * ⚠ THE FIFTH GROUP, `platform`, HAS NO TILE — AND THAT IS A DELIBERATE, DOCUMENTED GAP-FILL
 * (rulings addendum §A1). ADR-1055 names four DOMAIN groups and separately names `sweep.failed`
 * "on the sentinel", without assigning it one of the four. A sweep failure is not a
 * marketplace, money, capture or meetings problem; forcing it into one would make the tile
 * lie. So it carries `group: 'platform'`, which renders NO tile (the ADR's and the ticket's
 * "four group tiles" AC is honoured verbatim) and always appears in the DEFAULT unfiltered
 * list and in the header count — which is where the one row that can ever hold this group
 * belongs anyway.
 */
export type AdminAlertGroup = AdminAlertTileGroup | 'platform';

export type AdminAlertCadence = '1m' | '5m' | '15m';

/** Every cadence, in a stable order — what the sweep worker/cron registration iterates. */
export const ADMIN_ALERT_CADENCES: readonly AdminAlertCadence[] = ['1m', '5m', '15m'];

/**
 * What `entity_id` points at. Chosen for GRAIN — one open row per THING that can be fixed —
 * not for the design prototype's icon keys. `recording` and `transcript` are finer than the
 * prototype's `meeting` because a meeting can hold two failed recordings and collapsing them
 * would hide one. `wallet` replaces the prototype's `company` on the two `topup.*` kinds
 * because the reconcile works per wallet and the wallet is the id in hand at the raise site.
 */
export type AdminAlertEntityType =
  | 'expert' // expert_profiles.id
  | 'company' // companies.id
  | 'wallet' // credit_wallets.id
  | 'session' // credit_sessions.id
  | 'meeting' // meetings.id
  | 'recording' // meeting_recordings.id
  | 'transcript' // transcripts.id
  | 'calendar' // calendar_connections.id
  | 'sweep'; // the sentinel — no table
