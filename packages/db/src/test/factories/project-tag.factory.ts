import { randomUUID } from 'node:crypto';
import { db } from '../../client';
import { projectTagGroups, projectTags } from '../../schema';
import type { ProjectTagGroup, ProjectTag } from '../../schema';
import { referenceDataRepository } from '../../repositories/reference-data';

// Cache the vertical ID — seeded in global-setup, never rolled back.
let cachedVerticalId: string | undefined;

async function getSalesforceVerticalId(): Promise<string> {
  if (!cachedVerticalId) {
    cachedVerticalId = (await referenceDataRepository.getSalesforceVertical()).id;
  }
  return cachedVerticalId;
}

interface ProjectTagGroupOverrides {
  verticalId?: string;
  name?: string;
  slug?: string;
  sortOrder?: number;
  isActive?: boolean;
  deletedAt?: Date | null;
}

/**
 * Inserts a project_tag_groups row, defaulting to the seeded Salesforce
 * vertical. Slug is randomised to avoid collisions on the (vertical_id, slug)
 * unique across the shared, never-rolled-back vertical.
 */
export async function projectTagGroupFactory(
  overrides: ProjectTagGroupOverrides = {}
): Promise<ProjectTagGroup> {
  const verticalId = overrides.verticalId ?? (await getSalesforceVerticalId());
  const suffix = randomUUID().slice(0, 8);

  const [row] = await db
    .insert(projectTagGroups)
    .values({
      verticalId,
      name: overrides.name ?? `Group ${suffix}`,
      slug: overrides.slug ?? `group-${suffix}`,
      sortOrder: overrides.sortOrder ?? 0,
      isActive: overrides.isActive ?? true,
      deletedAt: overrides.deletedAt ?? null,
    })
    .returning();
  if (row === undefined) {
    throw new Error('project tag group insert failed');
  }
  return row;
}

interface ProjectTagOverrides {
  verticalId?: string;
  groupId?: string;
  name?: string;
  slug?: string;
  sortOrder?: number;
  isActive?: boolean;
  deletedAt?: Date | null;
}

/**
 * Inserts a project_tags row. Creates an owning group (same vertical) if one is
 * not supplied. Slug randomised to avoid collisions on (vertical_id, slug).
 */
export async function projectTagFactory(overrides: ProjectTagOverrides = {}): Promise<ProjectTag> {
  const verticalId = overrides.verticalId ?? (await getSalesforceVerticalId());
  const groupId = overrides.groupId ?? (await projectTagGroupFactory({ verticalId })).id;
  const suffix = randomUUID().slice(0, 8);

  const [row] = await db
    .insert(projectTags)
    .values({
      verticalId,
      groupId,
      name: overrides.name ?? `Tag ${suffix}`,
      slug: overrides.slug ?? `tag-${suffix}`,
      sortOrder: overrides.sortOrder ?? 0,
      isActive: overrides.isActive ?? true,
      deletedAt: overrides.deletedAt ?? null,
    })
    .returning();
  if (row === undefined) {
    throw new Error('project tag insert failed');
  }
  return row;
}
