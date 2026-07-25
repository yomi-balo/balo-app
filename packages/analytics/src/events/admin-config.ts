/**
 * BAL-398 (ADR-1044) — platform-config admin analytics.
 *
 * SERVER-ONLY. `admin_min_consultation_length_set` fires from the platform-config
 * Server Action via `trackServerAndFlush` after the upsert commits. It is a SERVER
 * event because it is a Balo-staff mutation whose config figure is admin-audience
 * data that must never transit a client bundle (same audience-boundary invariant as
 * `PROMO_CODE_CREATED` / `ADMIN_PROJECT_FEE_OVERRIDDEN`). It must NOT be added to
 * `AllEvents` (the client union) nor to the `apps/web/src/test/setup.ts` client mock.
 *
 * NO PII: only the new minimum (whole minutes) and the acting admin's `distinct_id`
 * (user UUID).
 */
export const ADMIN_CONFIG_SERVER_EVENTS = {
  MIN_CONSULTATION_LENGTH_SET: 'admin_min_consultation_length_set',
} as const;

export interface AdminConfigServerEventMap {
  // Emitted server-side from the admin config action, ONLY on a successful persist.
  // `distinct_id` is the acting admin; `minutes` is the new platform-wide minimum.
  [ADMIN_CONFIG_SERVER_EVENTS.MIN_CONSULTATION_LENGTH_SET]: {
    minutes: number;
    distinct_id: string;
  };
}
