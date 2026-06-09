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

export type ProjectRequestStatus = ProjectRequest['status'];

/**
 * Allowed request-level transitions. Linear spine with an admin-driven invite
 * branch. `kickoff_approved` is terminal. `draft` is the pre-submit state and
 * only flows to `requested`. Note: `exploratory_meeting_requested` is OPTIONAL —
 * a request may go `requested → experts_invited` directly OR via the meeting
 * state. The request-level status is the max-progress aggregate across all
 * per-expert relationships, advanced explicitly by the caller — never derived.
 */
export const STATUS_TRANSITIONS: Record<ProjectRequestStatus, readonly ProjectRequestStatus[]> = {
  draft: ['requested'],
  requested: ['exploratory_meeting_requested', 'experts_invited'],
  exploratory_meeting_requested: ['experts_invited'],
  experts_invited: ['eoi_submitted'],
  eoi_submitted: ['proposal_requested'],
  proposal_requested: ['proposal_submitted'],
  proposal_submitted: ['accepted'],
  accepted: ['kickoff_approved'],
  kickoff_approved: [],
};

export function isAllowedTransition(from: ProjectRequestStatus, to: ProjectRequestStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export class InvalidStatusTransitionError extends Error {
  constructor(
    public readonly from: ProjectRequestStatus,
    public readonly to: ProjectRequestStatus
  ) {
    super(`Invalid project_request status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

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

  /**
   * Live request by id, hydrated with the relations the detail page needs:
   * company, creator, project-type tags, products, brief documents, and the
   * per-expert relationships (each with its expert's user identity). Returns
   * `undefined` for a missing or soft-deleted request.
   *
   * Soft-delete-aware at EVERY level — the top row AND each child collection
   * filter `deletedAt IS NULL`. Columns are allow-listed (defense-in-depth,
   * mirrors `findPublicProfileByUsername`): only what the view-model needs
   * crosses the boundary. The new budget/timeline columns are included so they
   * hydrate into the view-model. `users.email` is selected solely as a
   * contact-name fallback and is dropped server-side in the mapper before any
   * contact-gated payload reaches the client.
   */
  async findByIdWithRelations(id: string) {
    return db.query.projectRequests.findFirst({
      where: and(eq(projectRequests.id, id), isNull(projectRequests.deletedAt)),
      columns: {
        id: true,
        companyId: true,
        expertProfileId: true,
        createdByUserId: true,
        sendTo: true,
        status: true,
        source: true,
        title: true,
        description: true,
        budgetMinCents: true,
        budgetMaxCents: true,
        budgetCurrency: true,
        timeline: true,
        createdAt: true,
        updatedAt: true,
      },
      with: {
        company: { columns: { id: true, name: true } },
        createdByUser: {
          columns: { id: true, firstName: true, lastName: true, email: true },
        },
        tags: {
          where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
          with: { projectTag: { columns: { id: true, name: true } } },
        },
        products: {
          where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
          with: { product: { columns: { id: true, name: true } } },
        },
        documents: {
          where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
          columns: { id: true, fileName: true, sizeBytes: true, contentType: true },
        },
        relationships: {
          where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
          columns: { id: true, expertProfileId: true, status: true, invitedAt: true },
          with: {
            expertProfile: {
              columns: { id: true },
              with: { user: { columns: { id: true, firstName: true, lastName: true } } },
            },
          },
        },
      },
    });
  },

  /**
   * Atomically advance a request's status with from→to validation. Reads the
   * current row FOR UPDATE inside the txn (serialising concurrent admin
   * transitions), rejects illegal transitions (`InvalidStatusTransitionError`)
   * and missing/soft-deleted rows (`Error`), then persists. Returns the updated
   * row.
   *
   * `expectedFrom` is an optional optimistic-concurrency guard: if provided and
   * the live status differs, throws (prevents lost-update races between admins).
   */
  async transitionStatus(input: {
    id: string;
    to: ProjectRequestStatus;
    expectedFrom?: ProjectRequestStatus;
  }): Promise<ProjectRequest> {
    return db.transaction(async (tx) => {
      // Relational `db.query.*` does not support FOR UPDATE — use the core
      // builder to lock the row for the duration of the transaction.
      const [current] = await tx
        .select()
        .from(projectRequests)
        .where(and(eq(projectRequests.id, input.id), isNull(projectRequests.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Project request not found: ${input.id}`);
      }

      if (input.expectedFrom !== undefined && current.status !== input.expectedFrom) {
        throw new InvalidStatusTransitionError(current.status, input.to);
      }

      if (!isAllowedTransition(current.status, input.to)) {
        throw new InvalidStatusTransitionError(current.status, input.to);
      }

      const [updated] = await tx
        .update(projectRequests)
        .set({ status: input.to })
        .where(eq(projectRequests.id, input.id))
        .returning();

      if (updated === undefined) {
        throw new Error(`Failed to update project request: ${input.id}`);
      }

      return updated;
    });
  },
};

/**
 * The hydrated request shape the detail page (and its lens resolver / view-model
 * mapper) consume. `NonNullable` because `findByIdWithRelations` returns
 * `undefined` for a missing/soft-deleted request; callers that have already
 * `notFound()`-guarded the undefined branch hold this non-null type.
 */
export type ProjectRequestWithRelations = NonNullable<
  Awaited<ReturnType<typeof projectRequestsRepository.findByIdWithRelations>>
>;
