import type { ProjectRequestWithRelations } from '@balo/db';

type Relationship = ProjectRequestWithRelations['relationships'][number];

/** An expert's display name for notification copy; "An expert" when no name is on file. */
export function expertDisplayName(relationship: Relationship): string {
  const { user } = relationship.expertProfile;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : 'An expert';
}
