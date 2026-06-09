'use server';

import 'server-only';

import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/require-admin';
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
 * Thin admin-only wrapper over the web `searchExperts()` seam (→ `GET /experts/search`).
 *
 * Going through the route — not the repo — keeps a single owner of rate-limiting,
 * Redis facet caching, server analytics, and vertical-slug resolution. The picker
 * is a client dialog that calls THIS action and renders the returned minimal rows.
 */
export async function searchExpertsForInviteAction(
  input: z.infer<typeof inputSchema>
): Promise<SearchExpertsForInviteResult> {
  try {
    await requireAdmin();
  } catch {
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
