'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { LOOKUP_FOLLOW_UP_TYPES, type LookupFollowUpsResult } from '../_lib/follow-ups-view';
import { loadLookupFollowUps } from '../_lib/load-lookup-follow-ups';

/**
 * BAL-666 — the client seam for the Lookup drill-in's Follow-ups tab, on
 * `fetch-lookup-timeline.ts`'s precedent: the drill-in is a client component and the loader is
 * `server-only`, so this Server Action is the callable bridge.
 *
 * ⚠ Middleware does NOT protect Server Actions (workos-auth skill) — `requireOnboardedUser()`
 * is the real gate, then `VIEW_PLATFORM_ADMIN`.
 *
 * ⚠ `z.enum(LOOKUP_FOLLOW_UP_TYPES)` IS THE SECURITY GATE — the client can never name a free
 * entity type; only the four types that carry a Follow-ups tab parse.
 *
 * ⚠ READ-ONLY, and it reaches NO repository member directly (the loader does). Opening the tab
 * writes nothing and sends nothing.
 *
 * A `'use server'` module exports ONLY async functions — every type here is `import type`.
 */

const inputSchema = z.object({
  type: z.enum(LOOKUP_FOLLOW_UP_TYPES),
  id: z.uuid(),
});

export async function fetchLookupFollowUpsAction(input: unknown): Promise<LookupFollowUpsResult> {
  const user = await requireOnboardedUser();

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'not_found' };
  }

  try {
    return await loadLookupFollowUps(user, parsed.data);
  } catch (error) {
    log.error('Admin lookup follow-ups fetch failed', {
      userId: user.id,
      entityType: parsed.data.type,
      entityId: parsed.data.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, reason: 'unavailable' };
  }
}
