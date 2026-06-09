import { db } from '../../client';
import { requestExpertRelationships } from '../../schema';
import type { RequestExpertRelationship, NewRequestExpertRelationship } from '../../schema';
import { userFactory } from './user.factory';
import { projectRequestFactory } from './project-request.factory';

interface RequestExpertRelationshipFactoryOverrides {
  /** Reuse an existing request instead of seeding a fresh one. */
  projectRequestId?: string;
  /** Target expert. Defaults to the seeded request's expert. */
  expertProfileId?: string;
  /** Inviter (admin). Defaults to a fresh admin user. */
  invitedByUserId?: string;
  /** Row-level overrides (status, declinedAt, deletedAt, …). */
  values?: Partial<NewRequestExpertRelationship>;
}

export interface RequestExpertRelationshipFactoryResult {
  relationship: RequestExpertRelationship;
  projectRequestId: string;
  expertProfileId: string;
  invitedByUserId: string;
}

/**
 * Seeds a live project request (via `projectRequestFactory`, which also creates a
 * target expert), an admin inviter user, then inserts an `invited`
 * `request_expert_relationships` row. Returns the relationship plus its
 * request/expert/inviter ids for cross-table assertions.
 */
export async function requestExpertRelationshipFactory(
  overrides: RequestExpertRelationshipFactoryOverrides = {}
): Promise<RequestExpertRelationshipFactoryResult> {
  let projectRequestId = overrides.projectRequestId;
  let expertProfileId = overrides.expertProfileId;

  if (projectRequestId === undefined || expertProfileId === undefined) {
    const request = await projectRequestFactory();
    projectRequestId = projectRequestId ?? request.id;
    // The seeded request is a `direct` request → its expertProfileId is non-null.
    expertProfileId = expertProfileId ?? request.expertProfileId ?? undefined;
  }

  if (expertProfileId === undefined) {
    throw new Error(
      'requestExpertRelationshipFactory: expertProfileId could not be resolved (supply one explicitly).'
    );
  }

  const invitedByUserId =
    overrides.invitedByUserId ?? (await userFactory({ platformRole: 'admin' })).id;

  const [relationship] = await db
    .insert(requestExpertRelationships)
    .values({
      projectRequestId,
      expertProfileId,
      invitedByUserId,
      ...overrides.values,
    })
    .returning();
  if (relationship === undefined) {
    throw new Error('request expert relationship insert failed');
  }

  return {
    relationship,
    projectRequestId,
    expertProfileId,
    invitedByUserId,
  };
}
