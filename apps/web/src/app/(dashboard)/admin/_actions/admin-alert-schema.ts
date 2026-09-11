import { z } from 'zod';
import {
  ADMIN_ALERT_NOTE_MIN,
  ADMIN_ALERT_NOTE_MAX,
  ADMIN_ALERT_KIND_KEYS,
  isKnownAdminAlertKind,
  isStormKind,
} from '@balo/shared/admin-alerts';

/** Every literal kind string a legitimate `?group=` filter can ever produce is a registered
 *  kind or its `.storm` derivative — `adminAlertKindsForGroupFilter` pushes exactly those two
 *  per matching kind (`admin-queue-view.ts`). Bounding at twice the full registry size is
 *  already generous for any real filter while still refusing a self-DoS-sized array. */
const ADMIN_ALERT_KINDS_FILTER_MAX = ADMIN_ALERT_KIND_KEYS.length * 2;

/**
 * BAL-548 / ADR-1055 — the schema + result type for the admin-alerts Server Actions.
 *
 * ⚠ A SIBLING FILE, NOT INLINED IN `close-admin-alert.ts`. A `'use server'` module may export
 * ONLY async functions — the `promo-code-schema.ts` shape, verbatim.
 *
 * Bounds are imported from `@balo/shared/admin-alerts`, the same constants the repository's
 * `resolutionNote` column and the row's UI copy already share, so the dialog's client-side
 * hint, this Zod layer, and the DB CHECK-adjacent length bound can never drift.
 */
export const closeAdminAlertSchema = z
  .object({
    alertId: z.uuid(),
    note: z.string().trim().min(ADMIN_ALERT_NOTE_MIN).max(ADMIN_ALERT_NOTE_MAX),
  })
  .strict();

export type CloseAdminAlertInput = z.infer<typeof closeAdminAlertSchema>;

export type CloseAdminAlertResult =
  | { success: true }
  | {
      success: false;
      error: string;
      reason: 'forbidden' | 'not_found' | 'finder_kind' | 'already_resolved' | 'invalid' | 'failed';
    };

/**
 * Keyset page request for the "Load more" control — read-only.
 *
 * BAL-548 fix round (B-F8) — `kinds` is bounded AND membership-checked. Unbounded, a
 * staff-authenticated caller could post an arbitrarily large array straight into
 * `inArray(adminAlerts.kind, [...])`; Drizzle parameterises it (not injection) and an unknown
 * kind can only narrow results to nothing (not an exposure), but a huge array is still a
 * self-DoS surface worth refusing at the schema.
 */
export const loadMoreAdminAlertsSchema = z
  .object({
    kinds: z
      .array(z.string())
      .max(ADMIN_ALERT_KINDS_FILTER_MAX)
      .refine(
        (values) => values.every((kind) => isKnownAdminAlertKind(kind) || isStormKind(kind)),
        {
          message: 'Unknown admin alert kind',
        }
      )
      .optional(),
    afterFirstSeenAtIso: z.iso.datetime(),
    afterId: z.uuid(),
  })
  .strict();

export type LoadMoreAdminAlertsInput = z.infer<typeof loadMoreAdminAlertsSchema>;
