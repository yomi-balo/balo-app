'use server';

import 'server-only';

import { adminAlertsRepository } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { ADMIN_ALERT_PAGE_SIZE } from '@balo/shared/admin-alerts';
import {
  buildAdminQueueRow,
  nextAdminQueueCursor,
  type AdminQueueRowView,
  type AdminQueueCursor,
} from '../_lib/admin-queue-view';
import { loadMoreAdminAlertsSchema } from './admin-alert-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
const GENERIC_FAILURE = 'Could not load more. Try again in a moment.';

export type LoadMoreAdminAlertsResult =
  | {
      success: true;
      rows: readonly AdminQueueRowView[];
      hasMore: boolean;
      nextCursor: AdminQueueCursor | null;
    }
  | { success: false; error: string };

/**
 * BAL-548 / ADR-1055 — the Home page's keyset "Load more", a READ-ONLY Server Action.
 *
 * Gated on `VIEW_PLATFORM_ADMIN` (reachability), NOT `RESOLVE_ADMIN_ALERTS` (that token gates
 * the CLOSE mutation only — a viewer can read the queue without holding it, exactly as a
 * viewer without `MANAGE_PROMO_CODES` still sees the promo-code list).
 *
 * Maps its page through `buildAdminQueueRow` — the SAME per-row function `buildAdminQueueView`
 * uses for the first page (never a second row mapper) — so fee concealment and copy cannot
 * diverge between the first page and every subsequent one. `kinds` re-applies the page's
 * current group filter on every call.
 *
 * ⚠ Uses `getCurrentUser()`, not a bare `requireUser()` — this module does NOT go on
 * `READ_ONLY_ALLOWLIST` (that list is specifically for actions authenticating with a bare
 * `requireUser()`), matching the admin idiom (rulings addendum §A6).
 */
export async function loadMoreAdminAlerts(input: {
  kinds?: readonly string[];
  afterFirstSeenAtIso: string;
  afterId: string;
}): Promise<LoadMoreAdminAlertsResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = loadMoreAdminAlertsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: GENERIC_FAILURE };
  }
  const { kinds, afterFirstSeenAtIso, afterId } = parsed.data;
  const canSeeFees = hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES);

  try {
    const now = new Date();
    const page = await adminAlertsRepository.listOpenPage({
      kinds,
      after: { firstSeenAt: new Date(afterFirstSeenAtIso), id: afterId },
      limit: ADMIN_ALERT_PAGE_SIZE,
    });

    const rows = page.alerts.map((alert) => buildAdminQueueRow(alert, { canSeeFees, now }));

    return {
      success: true,
      rows,
      hasMore: page.hasMore,
      nextCursor: nextAdminQueueCursor(rows, page.hasMore),
    };
  } catch (error) {
    log.error('Failed to load more admin alerts', {
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
