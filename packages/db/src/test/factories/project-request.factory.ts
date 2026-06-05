import { db } from '../../client';
import { companies, companyMembers, projectRequests } from '../../schema';
import type { ProjectRequest, NewProjectRequest } from '../../schema';
import { userFactory } from './user.factory';
import { expertDraftFactory } from './expert-draft.factory';

/**
 * Seeds a complete project-request graph: a creator user + their personal
 * company (owner membership) + a target expert draft, then inserts a
 * `project_requests` row. Overrides are merged onto the row's `.values(...)`.
 *
 * No companies factory exists yet, so the company + membership are inserted via
 * `db` directly. For FK-violation tests, call `createProjectRequest` with a
 * random uuid for the bad FK rather than going through this factory.
 */
export async function projectRequestFactory(
  overrides: Partial<NewProjectRequest> = {}
): Promise<ProjectRequest> {
  const creator = await userFactory();

  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }

  await db
    .insert(companyMembers)
    .values({ companyId: company.id, userId: creator.id, role: 'owner' });

  const expert = await expertDraftFactory();

  const [row] = await db
    .insert(projectRequests)
    .values({
      companyId: company.id,
      expertProfileId: expert.id,
      createdByUserId: creator.id,
      title: 'Lead routing rebuild',
      description: 'Rebuild lead routing in Flow with proper assignment rules.',
      ...overrides,
    })
    .returning();
  if (row === undefined) {
    throw new Error('project request insert failed');
  }

  return row;
}
