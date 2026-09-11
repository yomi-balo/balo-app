'use server';

import 'server-only';

import { z } from 'zod';
import { LOOKUP_ENTITY_TYPES } from '@balo/shared/lookup';
import type { LookupTimelineResult } from '@balo/shared/lookup';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { loadLookupTimeline } from '../_lib/load-lookup-timeline';

/**
 * BAL-555 — the client seam for the Lookup drill-in's Timeline section. The drill-in is a
 * client component and `load-lookup-timeline.ts` is `server-only`, so this Server Action is
 * the callable bridge (a nested Server Component with `<Suspense>` would force the selection
 * into the URL, which BAL-551's plan §2.1 rules against) — verbatim on
 * `_actions/fetch-lookup-money-block.ts`'s precedent.
 *
 * ⚠ Middleware does NOT protect Server Actions (workos-auth skill) — `requireOnboardedUser()`
 * is the real gate here, not the page-level capability check.
 *
 * ⚠ `z.enum(LOOKUP_ENTITY_TYPES)` IS THE SECURITY GATE (C7) — the client can never name a
 * free `entity_type` string; only a shipped `LookupEntityType` parses.
 *
 * ⚠ NOT on `READ_ONLY_ALLOWLIST` — that list is the bare-`requireUser()` onboarding-gate
 * register, a different axis (BAL-551 pre-flight O7).
 *
 * ⚠ It reaches NO repository member directly (the loader does), preserving the shape
 * `admin-lookup-never-writes.test.ts` already asserts for the money action.
 *
 * A `'use server'` module exports ONLY async functions (memory
 * `reference_use_server_no_value_exports`) — every type here is `import type` and never
 * re-exported.
 *
 * ⚠ BAL-555 fix round — `before.createdAtPrecise` is NOT strict ISO 8601 despite carrying a
 * timestamp (see `LookupTimelineCursorDTO`'s docblock, `@balo/shared/lookup`): it carries the
 * cursor at FULL microsecond precision, exactly as Postgres prints a `timestamptz`
 * (`created_at::text`), e.g. `'2026-09-11 10:00:00.083951+00'` — a space separator, no `T`, and
 * a 2-digit zone offset. `z.iso.datetime()` REJECTS that shape outright, so it cannot be reused
 * here. Loosening to a bare `z.string()` would accept anything, so this is an ANCHORED,
 * non-backtracking regex (no nested quantifiers — SonarCloud S5852) plus a hard length cap, not
 * a shape this table's text form could ever exceed.
 */

const POSTGRES_TIMESTAMPTZ_TEXT_MAX_LENGTH = 35;
const POSTGRES_TIMESTAMPTZ_TEXT_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

const inputSchema = z.object({
  type: z.enum(LOOKUP_ENTITY_TYPES),
  id: z.uuid(),
  before: z
    .object({
      createdAtPrecise: z
        .string()
        .max(POSTGRES_TIMESTAMPTZ_TEXT_MAX_LENGTH)
        .regex(POSTGRES_TIMESTAMPTZ_TEXT_PATTERN),
      seq: z.number().int().nonnegative(),
    })
    .optional(),
});

export async function fetchLookupTimelineAction(input: unknown): Promise<LookupTimelineResult> {
  const user = await requireOnboardedUser();

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'not_found' };
  }

  try {
    return await loadLookupTimeline(user, parsed.data);
  } catch (error) {
    log.error('Admin lookup timeline fetch failed', {
      userId: user.id,
      entityType: parsed.data.type,
      entityId: parsed.data.id,
      hasCursor: parsed.data.before !== undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, reason: 'unavailable' };
  }
}
