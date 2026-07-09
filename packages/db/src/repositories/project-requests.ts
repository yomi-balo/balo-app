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
import { auditEventsRepository } from './audit-events';

export type ProjectRequestStatus = ProjectRequest['status'];

/**
 * Allowed request-level transitions. Linear spine with an admin-driven invite
 * branch. `kickoff_approved` is terminal. `draft` is the pre-submit state and
 * only flows to `requested`. Note: `exploratory_meeting_requested` is OPTIONAL —
 * a request may go `requested → experts_invited` directly OR via the meeting
 * state. This map guards ONLY the admin-driven, non-relationship-derived moves
 * (see `transitionStatus`). The relationship-derived portion of the request
 * status — the max-progress aggregate across all per-expert relationships — is
 * NOT validated here: it is centrally DERIVED by `deriveRequestStatus` inside
 * `advanceRelationshipStatus` (ADR-1025 / BAL-295) and written directly.
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

/**
 * The two persisted kickoff gates (BAL-291 / A6.5). The third — the admin
 * "settle invoice + approve" gate — is collapsed into the status transition
 * (`done ⟺ status === 'kickoff_approved'`), so it has no gate value here.
 */
export type KickoffGate = 'client_billing' | 'expert_terms';

export class InvalidKickoffStateError extends Error {
  constructor(public readonly status: ProjectRequestStatus) {
    super(`Kickoff gate cannot be set while request is ${status}`);
    this.name = 'InvalidKickoffStateError';
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

/**
 * Outcome of an admin per-request Balo-fee override (BAL-358). `changed` is
 * `false` when the requested `newBps` already equals the live value — a genuine
 * no-op: NO update is issued and NO audit row is written. The `apps/web` caller
 * uses `changed` to decide whether to emit its post-commit analytics / toast.
 */
export interface UpdateBaloFeeBpsResult {
  previousBps: number;
  newBps: number;
  changed: boolean;
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
        baloFeeBps: true,
        timeline: true,
        clientBillingConfirmedAt: true,
        expertTermsConfirmedAt: true,
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
          // `updatedAt` feeds the pipeline-health "last activity" derivation
          // alongside the latest live EOI/message timestamps below.
          columns: {
            id: true,
            expertProfileId: true,
            status: true,
            invitedAt: true,
            updatedAt: true,
          },
          with: {
            expertProfile: {
              columns: { id: true },
              with: { user: { columns: { id: true, firstName: true, lastName: true } } },
            },
            // Newest live EOI per relationship — its `submittedAt` is one of the
            // "last activity" signals. `limit: 1` newest-first, soft-delete-aware.
            expressionsOfInterest: {
              where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
              // `message` is the viewer-expert's own sanitised-HTML pitch, surfaced
              // so the expert lens can re-read their submitted EOI (view-model
              // `viewerEoi`); never another expert's — the mapper gates on the
              // viewer's relationship.
              columns: { id: true, submittedAt: true, message: true },
              orderBy: (t, { desc: childDesc }) => [childDesc(t.submittedAt)],
              limit: 1,
            },
            // Newest live conversation message per relationship — its `createdAt`
            // is the "talking" recency signal. `limit: 1` newest-first, soft-delete-aware.
            conversationMessages: {
              where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
              columns: { id: true, createdAt: true },
              orderBy: (t, { desc: childDesc }) => [childDesc(t.createdAt)],
              limit: 1,
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
   * ADMIN-ONLY (ADR-1025 / BAL-295): use this ONLY for admin-driven,
   * NON-relationship-derived moves — `requested → exploratory_meeting_requested`,
   * `requested → experts_invited`, `exploratory_meeting_requested →
   * experts_invited`, and `accepted → kickoff_approved`. Relationship-derived
   * transitions (`experts_invited → eoi_submitted → proposal_requested →
   * proposal_submitted → accepted`) flow ONLY through `deriveRequestStatus` inside
   * `advanceRelationshipStatus`, which writes the request status directly; callers
   * must NOT re-issue those moves here (they would be redundant and may trip the
   * single-step map even though the rollup already advanced the request).
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

  /**
   * Confirm a kickoff gate (`client_billing` or `expert_terms`) on a request.
   * Idempotent — the first confirmation's timestamp is PRESERVED on re-confirm
   * (the audit records when the gate was FIRST cleared, not the latest click).
   * Status-guarded to `accepted` (the only state the kickoff board renders in):
   * a gate cannot be set before acceptance or after approval —
   * `InvalidKickoffStateError` otherwise. Locks the row FOR UPDATE for the
   * duration of the txn, exactly like `transitionStatus`, serialising concurrent
   * confirmations. Returns the updated row.
   */
  async confirmKickoffGate(input: { id: string; gate: KickoffGate }): Promise<ProjectRequest> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(projectRequests)
        .where(and(eq(projectRequests.id, input.id), isNull(projectRequests.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Project request not found: ${input.id}`);
      }

      if (current.status !== 'accepted') {
        throw new InvalidKickoffStateError(current.status);
      }

      const set =
        input.gate === 'client_billing'
          ? { clientBillingConfirmedAt: current.clientBillingConfirmedAt ?? new Date() }
          : { expertTermsConfirmedAt: current.expertTermsConfirmedAt ?? new Date() };

      const [updated] = await tx
        .update(projectRequests)
        .set(set)
        .where(eq(projectRequests.id, input.id))
        .returning();

      if (updated === undefined) {
        throw new Error(`Failed to update project request: ${input.id}`);
      }

      return updated;
    });
  },

  /**
   * Admin per-request Balo-fee override (BAL-358). Atomically re-stamps
   * `balo_fee_bps` and writes an immutable `project_request.balo_fee_overridden`
   * audit row in the SAME transaction — the fee change and its "who overrode it,
   * from what, to what" record commit or roll back together. Reads the current
   * row FOR UPDATE (serialising concurrent admin overrides, exactly like
   * `transitionStatus` / `confirmKickoffGate`), throws on a missing/soft-deleted
   * request.
   *
   * No-op semantics: when `newBps` already equals the live value, NOTHING is
   * written — no UPDATE, no audit row — and the result carries `changed: false`.
   * The caller validates `newBps` is in-range; the
   * `project_requests_balo_fee_bps_range` CHECK is the last-line guard, not
   * re-validated here.
   */
  async updateBaloFeeBps(input: {
    requestId: string;
    newBps: number;
    actorUserId: string;
  }): Promise<UpdateBaloFeeBpsResult> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({ baloFeeBps: projectRequests.baloFeeBps })
        .from(projectRequests)
        .where(and(eq(projectRequests.id, input.requestId), isNull(projectRequests.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Project request not found: ${input.requestId}`);
      }

      if (current.baloFeeBps === input.newBps) {
        return { previousBps: current.baloFeeBps, newBps: input.newBps, changed: false };
      }

      const [updated] = await tx
        .update(projectRequests)
        .set({ baloFeeBps: input.newBps })
        .where(eq(projectRequests.id, input.requestId))
        .returning({ id: projectRequests.id });

      if (updated === undefined) {
        throw new Error(`Failed to update project request: ${input.requestId}`);
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'project_request.balo_fee_overridden',
          entityType: 'project_request',
          entityId: input.requestId,
          metadata: { previous_bps: current.baloFeeBps, new_bps: input.newBps },
        },
        tx
      );

      return { previousBps: current.baloFeeBps, newBps: input.newBps, changed: true };
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
