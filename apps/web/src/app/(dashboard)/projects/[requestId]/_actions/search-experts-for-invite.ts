'use server';

import 'server-only';

import { z } from 'zod';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { searchExperts } from '@/lib/search/search-data';
import { EMPTY_FILTERS } from '@/lib/search/filters';

const inputSchema = z.object({
  q: z.string().trim().max(120).optional(),
});

/** Minimal expert row the invite picker renders + selects from. */
export interface ExpertInviteOption {
  /** `expert_profiles.id` — exactly what `requestExpertRelationships.invite` needs. */
  id: string;
  name: string;
  headline: string | null;
  avatarUrl: string | null;
}

export type SearchExpertsForInviteResult =
  | { success: true; experts: ExpertInviteOption[] }
  | { success: false; error: string };

/**
 * Thin staff-only wrapper (`MANAGE_ANY_REQUEST_SOURCING`, SESSION-gated — see the allowlist
 * entry in `invariants/platform-capability-live-gate.test.ts` for the reason)
 * over the web `searchExperts()` seam (→ `GET /experts/search`).
 *
 * Going through the route — not the repo — keeps a single owner of rate-limiting,
 * Redis facet caching, server analytics, and vertical-slug resolution. The picker
 * is a client dialog that calls THIS action and renders the returned minimal rows.
 *
 * ⚠ BAL-558 — SESSION-GATED ONLY, DELIBERATELY NOT LIVE-GATED. This is a READ whose result
 * (id/name/headline/avatar) is the same PUBLIC marketplace data `GET /experts/search` serves
 * anonymously (no auth preHandler, only a fail-open rate limit — `apps/api/src/routes/experts
 * /search.ts`). A revoked staff member with a seven-day-stale cookie could see exactly what any
 * visitor sees; the act that matters, `invite-experts.ts`, IS live-gated. A live DB read on every
 * debounced (300ms) keystroke would spend a query for zero security boundary — see
 * `lib/authz/live-platform-capability.ts`'s "NOT FOR READ-ONLY LOADERS" docblock and the
 * allowlist in `invariants/platform-capability-live-gate.test.ts`.
 */
export async function searchExpertsForInviteAction(
  input: z.infer<typeof inputSchema>
): Promise<SearchExpertsForInviteResult> {
  let user: SessionUser | null;
  try {
    user = await getCurrentUser();
  } catch (error) {
    log.error('Session read failed at the invite expert-search gate — denying', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'You do not have permission to do this.' };
  }
  if (
    user === null ||
    !hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING)
  ) {
    return { success: false, error: 'You do not have permission to do this.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid search.' };
  }

  try {
    const response = await searchExperts({
      ...EMPTY_FILTERS,
      q: parsed.data.q ?? '',
      page: 1,
    });

    return {
      success: true,
      experts: response.experts.map((expert) => ({
        id: expert.id,
        name: expert.name,
        headline: expert.headline,
        avatarUrl: expert.avatarUrl,
      })),
    };
  } catch (error) {
    log.error('Failed to search experts for invite', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not load experts. Please try again.' };
  }
}
