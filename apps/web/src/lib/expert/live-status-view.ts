import type { ExpertLiveStatus } from '@balo/shared/experts';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

export interface LiveStatusView extends ExpertLiveStatus {
  readonly publicProfileHref: string | null;
}

/**
 * The public profile 404s unless the expert is searchable and has a username, so a link is only
 * offered when both hold.
 */
export function publicProfileHrefFor(username: string | null, searchable: boolean): string | null {
  if (!username || !searchable) return null;
  return `/experts/${username}`;
}

/** The serialisable shape the sidebar needs. `not_listed` never gets a profile link. */
export function buildLiveStatusView(
  status: Pick<ChecklistStatus, 'liveStatus' | 'username' | 'searchable'>
): LiveStatusView | null {
  const { liveStatus } = status;
  if (liveStatus === null) return null;
  return {
    ...liveStatus,
    publicProfileHref: publicProfileHrefFor(status.username, status.searchable),
  };
}
