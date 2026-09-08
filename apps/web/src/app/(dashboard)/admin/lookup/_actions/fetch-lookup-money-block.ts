'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import {
  fetchAdminSessionMoneyBlock,
  type AdminSessionMoneyResult,
} from '@/lib/api/admin-session-money-block';

/**
 * BAL-551 — the client seam for the Lookup drill-in's Money section. The drill-in is a client
 * component and `admin-session-money-block.ts` is `server-only`, so this Server Action is the
 * callable bridge (a nested Server Component with `<Suspense>` would force the selection into
 * the URL, which the plan's §2.1 rules against).
 *
 * ⚠ Middleware does NOT protect Server Actions (workos-auth skill) — `requireOnboardedUser()`
 * is the real gate here, not the page-level capability check.
 *
 * ⚠ NOT on `READ_ONLY_ALLOWLIST` (`apps/web/src/invariants/_read-only-actions.ts`) — that list
 * is the bare-`requireUser()` onboarding-gate exception register, and this action deliberately
 * does NOT want that exception (BAL-551 pre-flight O7): it uses `requireOnboardedUser()` like
 * any ordinary gated action.
 *
 * A `'use server'` module may export ONLY async functions (memory
 * `reference_use_server_no_value_exports`) — `AdminSessionMoneyResult` is imported as a type
 * only and never re-exported from here.
 */

const sessionIdSchema = z.uuid();

export async function fetchLookupMoneyBlockAction(
  sessionId: string
): Promise<AdminSessionMoneyResult> {
  const user = await requireOnboardedUser();

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    return { ok: false, reason: 'not_found' };
  }

  // Read-only — the api route is a GET, and this action reaches no repository member at all
  // (see apps/web/src/invariants/admin-lookup-never-writes.test.ts).
  return fetchAdminSessionMoneyBlock(parsed.data);
}
