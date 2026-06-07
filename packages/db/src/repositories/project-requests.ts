import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  projectRequests,
  projectRequestTags,
  projectRequestProducts,
  projectRequestDocuments,
  type ProjectRequest,
  type NewProjectRequest,
} from '../schema';

export interface ProjectRequestDocumentInput {
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface CreateProjectRequestInput {
  /**
   * Request row fields (companyId, createdByUserId, sendTo, expertProfileId|null,
   * status, source, title, sanitised-HTML description, …). The routing CHECK
   * constraint is enforced at the DB layer — the caller must supply an
   * expertProfileId for `direct` and omit it for `match`.
   */
  request: NewProjectRequest;
  /** Validated project-tag ids (already checked against the vertical taxonomy). */
  tagIds: string[];
  /** Validated product ids (already checked against the vertical taxonomy). */
  productIds: string[];
  /** Confirmed R2 document refs. */
  documents: ProjectRequestDocumentInput[];
}

export const projectRequestsRepository = {
  /**
   * Insert a submitted (or draft) project request together with its tag,
   * product, and document rows in ONE transaction. Returns the created request
   * row. Junction inserts assume the ids are pre-validated by the caller (the
   * `restrict` FKs are the last-line guard, not the validation surface).
   */
  async createProjectRequest(input: CreateProjectRequestInput): Promise<ProjectRequest> {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(projectRequests).values(input.request).returning();
      if (row === undefined) {
        throw new Error('Failed to create project request');
      }

      if (input.tagIds.length > 0) {
        await tx
          .insert(projectRequestTags)
          .values(input.tagIds.map((projectTagId) => ({ projectRequestId: row.id, projectTagId })));
      }

      if (input.productIds.length > 0) {
        await tx
          .insert(projectRequestProducts)
          .values(input.productIds.map((productId) => ({ projectRequestId: row.id, productId })));
      }

      if (input.documents.length > 0) {
        await tx
          .insert(projectRequestDocuments)
          .values(input.documents.map((d) => ({ projectRequestId: row.id, ...d })));
      }

      return row;
    });
  },

  /** Live (non-soft-deleted) request by id. Field-agnostic — selects the row only. */
  async findById(id: string): Promise<ProjectRequest | undefined> {
    return db.query.projectRequests.findFirst({
      where: and(eq(projectRequests.id, id), isNull(projectRequests.deletedAt)),
    });
  },
};
