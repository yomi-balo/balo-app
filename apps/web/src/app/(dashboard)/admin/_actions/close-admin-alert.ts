'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { adminAlertsRepository } from '@balo/db';
import { NOTE_CLOSEABLE_KINDS } from '@balo/shared/admin-alerts';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { closeAdminAlertSchema, type CloseAdminAlertResult } from './admin-alert-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
const INVALID_NOTE = 'Add a short note (at least 8 characters) saying what was done.';
const FINDER_KIND =
  'This one closes itself — the next sweep will clear it once the condition is gone.';
const ALREADY_RESOLVED = 'This was already closed. Refresh to see the current queue.';
const NOT_FOUND = 'This alert is no longer there.';
const GENERIC_FAILURE = 'Nothing was changed — the alert is still recorded. Try again in a moment.';

/**
 * BAL-548 / ADR-1055 — close a NO-FINDER `admin_alerts` row with a note (the pending-actions
 * queue's one mutation).
 *
 * Order of operations is the promo-codes idiom exactly (`deactivate-promo-code.ts`):
 *  1. `getCurrentUser()` — no session → generic denial, no repo call.
 *  2. `hasPlatformCapability(RESOLVE_ADMIN_ALERTS)` — resolved BEFORE the input is parsed, and
 *     the denial is the SAME generic string as step 1 (no existence leak, no "you're logged in
 *     but not staff" tell).
 *  3. Zod-parse (`.strict()`, `note` min 8 chars).
 *  4. `adminAlertsRepository.close` — a discriminated outcome, never a throw for the ordinary
 *     refusal arms (`finder_kind` / `already_resolved` / `not_found`). A finder kind is
 *     REFUSED, not closed: the next sweep tick would just re-raise it, so a manual close would
 *     be a lie that lasts one tick. This action does NOT re-check `NOTE_CLOSEABLE_KINDS`
 *     itself before calling — the repository is the single decider (its `kind` is read
 *     in-transaction, under `FOR UPDATE`, which this action cannot replicate without a second
 *     round trip) — but it DOES supply the policy set as data, never a registry read inside
 *     `@balo/db` (the `ReconcileKindInput` / `CloseAdminAlertInput` "arrives as data" rule).
 *
 * ⚠ ADMIN SURFACES USE `getCurrentUser()` + A CAPABILITY GATE, NOT `requireOnboardedUser()` —
 * verified against `deactivate-promo-code.ts` and the `AUTH_HELPERS` list (rulings addendum
 * §A6). This module therefore does NOT belong on `READ_ONLY_ALLOWLIST` (it authenticates via
 * `getCurrentUser`, not a bare `requireUser()`) and IS a WRITE — the single writer of
 * `admin_alerts` from `apps/web` (`admin-alerts-single-writer.test.ts`).
 *
 * ⚠ DEFENCE IN DEPTH: this action re-resolves `RESOLVE_ADMIN_ALERTS` itself and must not rely
 * on any layout-level gate — the same "repeated DELIBERATELY (D3)" note `catalogue/page.tsx`
 * carries for `VIEW_PLATFORM_ADMIN`.
 */
export async function closeAdminAlert(input: {
  alertId: string;
  note: string;
}): Promise<CloseAdminAlertResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, reason: 'forbidden', error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS)) {
    return { success: false, reason: 'forbidden', error: PERMISSION_DENIED };
  }

  const parsed = closeAdminAlertSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: 'invalid', error: INVALID_NOTE };
  }
  const { alertId, note } = parsed.data;

  try {
    const outcome = await adminAlertsRepository.close({
      alertId,
      actorUserId: user.id,
      note,
      noteCloseableKinds: NOTE_CLOSEABLE_KINDS,
    });

    switch (outcome.outcome) {
      case 'closed':
        log.info('Admin closed an alert', {
          alertId,
          kind: outcome.alert.kind,
          actorUserId: user.id,
        });
        revalidatePath('/admin');
        return { success: true };
      case 'finder_kind':
        return { success: false, reason: 'finder_kind', error: FINDER_KIND };
      case 'already_resolved':
        return { success: false, reason: 'already_resolved', error: ALREADY_RESOLVED };
      case 'not_found':
        return { success: false, reason: 'not_found', error: NOT_FOUND };
      default:
        return outcome satisfies never;
    }
  } catch (error) {
    log.error('Failed to close an admin alert', {
      alertId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, reason: 'failed', error: GENERIC_FAILURE };
  }
}
