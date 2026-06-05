import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { projectRequests, type ProjectRequest, type NewProjectRequest } from '../schema';

export const projectRequestsRepository = {
  /** Insert a submitted (or draft) project request. Returns the created row. */
  async createProjectRequest(data: NewProjectRequest): Promise<ProjectRequest> {
    const [row] = await db.insert(projectRequests).values(data).returning();
    if (row === undefined) {
      throw new Error('Failed to create project request');
    }
    return row;
  },

  /** Live (non-soft-deleted) request by id. */
  async findById(id: string): Promise<ProjectRequest | undefined> {
    return db.query.projectRequests.findFirst({
      where: and(eq(projectRequests.id, id), isNull(projectRequests.deletedAt)),
    });
  },
};
