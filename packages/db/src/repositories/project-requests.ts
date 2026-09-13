import { and, eq, inArray, isNull } from 'drizzle-orm';
// BAL-541 — the ONE place a platform role string may be interpreted (ADR-1029). `assignOwner`
// asks it whether a CANDIDATE owner is Balo staff; it never spells the role set itself.
import { platformRoleIsStaff } from '@balo/shared/authz';
import { db } from '../client';
import {
  expertProfiles,
  projectRequests,
  projectRequestTags,
  projectRequestProducts,
  projectRequestDocuments,
  users,
  type ProjectRequest,
  type ProjectRequestCloseReason,
  type NewProjectRequest,
  type RequestExpertRelationship,
} from '../schema';
import { auditEventsRepository } from './audit-events';
import { conversationsRepository } from './conversations';
import { cancelMeetingTx } from './_shared/cancel-meeting-tx';
import type { DbExecutor } from './_shared/db-executor';
import { acquireRequestLock } from './_shared/request-lock';
import { unionById } from './_shared/union-by-id';
import { meetingContextsRepository } from './meeting-contexts';
import { advanceProposalStatus, lockOpenProposalsForRequestTx } from './proposals';
import { representationsRepository } from './representations';
import {
  advanceRelationshipStatus,
  isAllowedRelationshipTransition,
  lockLiveRelationshipsForRequestTx,
} from './request-expert-relationships';

export type ProjectRequestStatus = ProjectRequest['status'];
type RelationshipStatus = RequestExpertRelationship['status'];

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
  draft: ['requested', 'closed'],
  requested: ['exploratory_meeting_requested', 'experts_invited', 'closed'],
  exploratory_meeting_requested: ['experts_invited', 'closed'],
  experts_invited: ['eoi_submitted', 'closed'],
  eoi_submitted: ['proposal_requested', 'closed'],
  proposal_requested: ['proposal_submitted', 'closed'],
  proposal_submitted: ['accepted', 'closed'],
  // ⚠ NO `'closed'` ON THESE TWO, DELIBERATELY (BAL-540). Once a proposal is accepted the
  // engagement is being stood up, and "close the sourcing process" is no longer the right
  // act — the ticket's AC says closing must be REFUSED from `accepted` and `kickoff_approved`,
  // and this map is what delivers it, through the existing `InvalidStatusTransitionError`.
  accepted: ['kickoff_approved'],
  kickoff_approved: [],
  // Terminal. Empty is also what makes a double-click on an already-closed request REFUSE
  // rather than re-run the cascade.
  closed: [],
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

/**
 * BAL-541 — outcome of naming (or clearing) a request's Balo owner. A DISCRIMINATED UNION
 * rather than a throw-or-boolean, because three of the four outcomes are ordinary product
 * states the action renders differently:
 *
 *   `assigned`        — the column moved and ONE audit row was appended.
 *   `unchanged`       — the candidate already IS the owner: no UPDATE, no audit row, no
 *                       notification, no analytics beat (the `updateBaloFeeBps` `changed:false`
 *                       semantics).
 *   `not_staff`       — the candidate exists but is not Balo staff. Nothing is written.
 *   `owner_not_found` — the candidate id names no live user. Nothing is written.
 *
 * A missing or soft-deleted REQUEST is the exception and still THROWS — it is a routing bug,
 * not a product state, and the caller pre-checks with `findById` for the friendly path.
 */
export type AssignRequestOwnerResult =
  | {
      outcome: 'assigned';
      /** Feeds the caller's `previous_owner_present` analytics flag. */
      previousOwnerUserId: string | null;
      /** `null` ⇒ the owner was CLEARED. */
      ownerUserId: string | null;
      /** The audit row's uuid — colon-free by construction, so it is a safe `correlationId`. */
      auditId: string;
    }
  | { outcome: 'unchanged'; ownerUserId: string | null }
  | { outcome: 'not_staff'; candidateUserId: string }
  | { outcome: 'owner_not_found'; candidateUserId: string };

/**
 * BAL-540 — the close cascade's input. Everything here is SERVER-DERIVED: `actorKind` comes
 * from WHICH authorization arm matched (membership `manage_requests` ⇒ `'client'`, platform
 * `close_any_request` ⇒ `'balo'`), never from the wire, and `actorUserId` from the session.
 */
export interface CloseRequestInput {
  requestId: string;
  actorUserId: string;
  actorKind: 'client' | 'balo';
  reason: ProjectRequestCloseReason;
  /**
   * ⚠ STAFF-ONLY, AND `null` ON THE CLIENT ARM ALWAYS. Persisted to `close_note`, which is the
   * note's ONLY home — it is never copied into the audit row (which records `hasNote` alone)
   * nor into any notification payload. The Balo arm's Zod schema requires it; the client arm's
   * forbids it.
   */
  note: string | null;
}

/**
 * BAL-540 — what one close produced. EVERY field exists because the caller's POST-COMMIT
 * fan-out needs it: this repository cannot notify, enqueue or call a vendor
 * (`invariants/repositories-never-notify.test.ts`), so the obligation is discharged from here.
 */
export interface CloseRequestResult {
  request: ProjectRequest;
  /** The status the request held before the close — the analytics `stage_at_close`. */
  previousStatus: ProjectRequestStatus;
  /**
   * The `project_request.closed` audit row id. A uuid, so COLON-FREE (the notification
   * dispatcher builds its BullMQ jobId from the RAW correlationId), and unique per WRITE
   * rather than per state — BullMQ silently no-ops an `add` whose jobId is already in the
   * retained completed set, so a `requestId`-derived key would swallow a genuine second event.
   */
  closeAuditId: string;
  /** One entry per track that WAS live and is now `declined`. Drives the expert fan-out. */
  declinedTracks: Array<{
    relationshipId: string;
    expertProfileId: string;
    /** The stage the track ended at — picks the notice's copy. */
    previousStatus: RelationshipStatus;
    declineAuditId: string;
  }>;
  withdrawnProposalIds: string[];
  /**
   * The meetings this close actually cancelled — NOT the ones it looked at. A meeting somebody
   * had already joined (`waiting_for_participants`) is absent, deliberately (orchestrator D1).
   * `expertProfileId` is whose availability cache the caller must rebuild post-commit (`null`
   * ⇒ nothing to rebuild); `cancelAuditId` is that teardown's per-WRITE idempotency key.
   */
  cancelledMeetings: Array<{
    meetingId: string;
    expertProfileId: string | null;
    cancelAuditId: string;
  }>;
  /**
   * The expert USER ids behind {@link declinedTracks}, deduped — the `recipientUserIds` of the
   * caller's `project.request_closed` publish.
   *
   * ⚠ RESOLVED INSIDE THE CLOSE TRANSACTION, AND THAT IS THE WHOLE POINT. The fan-out used to
   * map profile ids → user ids POST-COMMIT (`expertsRepository.findUserIdsByProfileIds` inside
   * the deferred callback). `runAfterResponse` has NO RETRY and the close has already
   * committed, so a single failed read there dropped the expert notices PERMANENTLY, with
   * nothing left to re-drive them. Resolving here makes the ids COMMITTED STATE that arrives
   * with the result: the fan-out has no post-commit read left to fail, only the publish itself.
   *
   * Ids ONLY — no email, no `workosId`, no row hydration. This repository hands the caller a
   * recipient key, never a person's PII (`reference_drizzle_with_hydration_leaks_secrets`).
   *
   * Filter semantics MIRROR `expertsRepository.findUserIdsByProfileIds` exactly: an expert
   * whose USER row is soft-deleted contributes no id (`expert_profiles` itself carries no
   * `deleted_at`), and the set is deduped because two tracks can name profiles owned by the
   * same person. Empty whenever `declinedTracks` is.
   */
  declinedTrackUserIds: readonly string[];
  /** Empty on every real close today — BAL-313 ships inert. Forward-compatible arm. */
  revokedRepresentationIds: string[];
}

/**
 * `expert_profiles.id[]` → live `users.id[]`, deduped, on the CALLER'S executor.
 *
 * The in-transaction twin of `expertsRepository.findUserIdsByProfileIds`, and deliberately not
 * a call to it: that method is bound to the base `db`, so from inside `close()`'s transaction
 * it would read on a SECOND pooled connection — outside the very transaction whose committed
 * state these ids are supposed to be part of. Same filter, same dedupe, same empty-input
 * short-circuit; explicit join projecting `users.id` alone rather than a relational `with:`,
 * so no full user row (email, `workos_id`) is ever hydrated.
 */
async function resolveExpertUserIdsTx(
  exec: DbExecutor,
  expertProfileIds: readonly string[]
): Promise<string[]> {
  if (expertProfileIds.length === 0) return [];
  const rows = await exec
    .select({ userId: users.id })
    .from(expertProfiles)
    .innerJoin(users, eq(expertProfiles.userId, users.id))
    .where(and(inArray(expertProfiles.id, [...expertProfileIds]), isNull(users.deletedAt)));
  return [...new Set(rows.map((row) => row.userId))];
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
   *
   * ⚠ `conversationMessages` IS GRAFTED, NOT HYDRATED (BAL-424). Messages no longer FK the
   * relationship — they hang off `conversations`, reached through the polymorphic, FK-less
   * `conversation_contexts` seam, which Drizzle's relational `with:` cannot traverse. The
   * array is rebuilt below from `conversationsRepository.latestMessagesForRelationships` in
   * ONE extra round trip, in the EXACT shape the `with:` produced (`{ id, createdAt }[]` of
   * length ≤ 1). That is deliberate and load-bearing: `ProjectRequestWithRelations` is
   * INFERRED from this function, so a shape change would ripple through the whole web app.
   */
  async findByIdWithRelations(id: string) {
    const row = await db.query.projectRequests.findFirst({
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
        // BAL-540 — the four terminal-close columns. `request-detail-view.ts`'s
        // `deriveClosedSummary` needs all four to render the `ClosedBanner` (D11 gates
        // `closeNote` on the viewer's platform capability, never here — the mapper reads it
        // unconditionally and the CALLER decides who sees it).
        closedAt: true,
        closedByUserId: true,
        closeReason: true,
        closeNote: true,
        // BAL-541 — widened by EXACTLY ONE column. ADMIN-AUDIENCE: `load-balo-panel.ts`
        // resolves the NAME behind `assign_any_request_owner`; `mapRequestToDetailView` carries
        // it on NO lens, not even the admin one (pinned by the sentinel leak test). Selected
        // here rather than re-read because the panel already has this row in hand.
        baloOwnerUserId: true,
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
          //
          // ⚠ BAL-283 widened this by EXACTLY ONE column, `availabilitySharedAt`, deliberately
          // NOT by `declinedAt`/`deletedAt` — at the time, nothing on the RENDER path needed
          // them; they were needed by exactly two MUTATIONS, which must re-read the row rather
          // than trust a render-path projection.
          //
          // ⚠ BAL-540 widens it again, by `declinedAt` + `declineReason` + `declinedByUserId`,
          // because a THIRD, genuinely render-path consumer now exists: the closed-request
          // track list (`closed-request-view.ts`'s `deriveClosedTracks`) needs `declineReason`
          // to pick each frozen track's final chip (`invite_withdrawn` / `declined` /
          // `ended_request_closed`), and `declinedAt` to prove D9's file historical-read flip
          // in tests. This does NOT reopen `relationshipDeniesHosting`'s guard — that resolver
          // reads its OWN authoritative row inside the engagement-host seam, never this
          // render-path projection.
          columns: {
            id: true,
            expertProfileId: true,
            status: true,
            invitedAt: true,
            updatedAt: true,
            availabilitySharedAt: true,
            declinedAt: true,
            declineReason: true,
            declinedByUserId: true,
          },
          with: {
            // ⚠ BAL-422 widened this allow-list by exactly TWO DISPLAY columns
            // (`ratingAverage` / `ratingCount`) so the proposal header and the review
            // summary card can show the expert's rating. That is consistent with the
            // defense-in-depth rationale above, not a hole in it: `rateCents` — the
            // UN-MARKED-UP consultant rate the client must never see — stays structurally
            // absent, which is the column this allow-list exists to keep out.
            //
            // ⚠ `ratingAverage` is `numeric` ⇒ a STRING here. A relational `columns:`
            // allow-list cannot reshape, so the parse happens at the view boundary
            // (`hydrateReviewDoc` → `parseRatingAverage`), which is still the ONE parse.
            expertProfile: {
              columns: { id: true, ratingAverage: true, ratingCount: true },
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
            // BAL-540 — EXISTENCE ONLY (`id` alone, `limit: 1`): whether this track had a
            // proposal. Drives `resolveEndedTrackView`'s `hadProposal` (the expert's
            // ended-track copy — "your proposal is no longer under review" only when one
            // genuinely existed). Never the proposal's money/method — those never belong on a
            // de-participated expert's own read.
            //
            // ⚠ SOFT-DELETE FILTERED, like every sibling sub-relation in this query. Without
            // it a track whose only proposal was soft-deleted told the ended-track view it
            // "had a proposal" and picked the wrong copy.
            proposals: {
              where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
              columns: { id: true },
              limit: 1,
            },
          },
        },
      },
    });

    if (row === undefined) {
      return undefined;
    }

    // SHAPE-PRESERVING GRAFT — see the docblock. One batched round trip over every
    // relationship on this request; never one per relationship.
    const latestByRelationship = await conversationsRepository.latestMessagesForRelationships(
      row.relationships.map((relationship) => relationship.id)
    );

    return {
      ...row,
      relationships: row.relationships.map((relationship) => {
        const latest = latestByRelationship.get(relationship.id);
        return {
          ...relationship,
          conversationMessages: latest === undefined ? [] : [latest],
        };
      }),
    };
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

  /**
   * BAL-541 — NAME (or CLEAR) THE BALO STAFFER WHO OWNS THIS REQUEST.
   *
   * Modelled line-for-line on {@link updateBaloFeeBps}: read the row FOR UPDATE, short-circuit
   * a genuine no-op, write the column, append ONE audit row — all in ONE `db.transaction`, so
   * the change and its "who moved it, from whom, to whom" record commit or roll back together.
   * The `FOR UPDATE` serialises concurrent admin assignments; two racing assignments queue and
   * the last writer wins, with BOTH audited. (Concurrency is argued by inspection here, as
   * `close()` does: the integration harness runs one transaction per test on a `max:1` pool, so
   * it cannot express a second connection.)
   *
   * ── CLEARING IS THE SAME ACT ──────────────────────────────────────────────────────────
   * `ownerUserId: null` is not a separate method: one column, one audit action, three
   * affordances (assign / reassign / clear). The audit row carries `to: null` and the caller
   * suppresses the notification — THIS METHOD KNOWS NOTHING ABOUT NOTIFICATIONS and must not
   * learn (`invariants/repositories-never-notify.test.ts`).
   *
   * ── STAFF ELIGIBILITY IS ENFORCED HERE, INTERPRETED ELSEWHERE ─────────────────────────
   * The candidate's `platform_role` is read INSIDE the transaction and judged by
   * `platformRoleIsStaff` from `@balo/shared/authz` — the ONE interpretation point for that
   * role set (ADR-1029). This repository never spells a role literal. The read takes NO ROW
   * LOCK, deliberately: an unlocked `users` read adds no edge to any lock-order sequence in
   * this package and so introduces no deadlock class (the `resolveExpertUserIdsTx` rationale).
   * A role change racing this assignment is ACCEPTED — the audit row records what was true at
   * commit.
   *
   * ⚠ THE READ SIDE NEVER RE-FILTERS ON ROLE. A staffer demoted after being named stays the
   * owner and stays displayed; only a NEW assignment is checked. That asymmetry is the point —
   * re-filtering on read would silently erase history.
   */
  async assignOwner(input: {
    requestId: string;
    ownerUserId: string | null;
    actorUserId: string;
  }): Promise<AssignRequestOwnerResult> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          baloOwnerUserId: projectRequests.baloOwnerUserId,
          updatedAt: projectRequests.updatedAt,
        })
        .from(projectRequests)
        .where(and(eq(projectRequests.id, input.requestId), isNull(projectRequests.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Project request not found: ${input.requestId}`);
      }

      // Genuine no-op — covers "re-selected the current owner" AND "cleared an already
      // unassigned request". Nothing is written, so nothing is audited or announced.
      if (current.baloOwnerUserId === input.ownerUserId) {
        return { outcome: 'unchanged', ownerUserId: current.baloOwnerUserId };
      }

      const candidateUserId = input.ownerUserId;
      if (candidateUserId !== null) {
        const [candidate] = await tx
          .select({ id: users.id, platformRole: users.platformRole })
          .from(users)
          .where(and(eq(users.id, candidateUserId), isNull(users.deletedAt)))
          .limit(1);

        if (candidate === undefined) {
          return { outcome: 'owner_not_found', candidateUserId };
        }
        if (!platformRoleIsStaff(candidate.platformRole)) {
          return { outcome: 'not_staff', candidateUserId };
        }
      }

      // ⚠ `updatedAt` is passed back EXPLICITLY to defeat the `timestamps` helper's
      // `$onUpdateFn` (Drizzle applies it only when the column is ABSENT from `.set()`).
      // `updated_at` is the admin stall signal — `requestRecencyAt` folds it and
      // `adminStallDays` reads the fold — and internal STAFFING is not request ACTIVITY:
      // without this, assigning an owner to a stalled request (the exact triage act) would
      // erase the very stall chip that prompted it. (`updateBaloFeeBps` has the same latent
      // bump; left as-is — fee overrides are rare and not a triage-surface act.)
      const [updated] = await tx
        .update(projectRequests)
        .set({ baloOwnerUserId: input.ownerUserId, updatedAt: current.updatedAt })
        .where(eq(projectRequests.id, input.requestId))
        .returning({ id: projectRequests.id });

      if (updated === undefined) {
        throw new Error(`Failed to update project request: ${input.requestId}`);
      }

      // ⚠ FIXED METADATA CONTRACT. `audit_events` is APPEND-ONLY — no `updated_at`, no
      // backfill — so this shape is unrecoverable if wrong; it is asserted key-by-key in
      // `project-requests.integration.test.ts`. `from`/`to` are USER IDS and `null` means
      // unset/cleared. NO names and NO roles: both are mutable elsewhere, so storing them
      // would freeze a stale copy of somebody's identity into an immutable row.
      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'project_request.owner_assigned',
          entityType: 'project_request',
          entityId: input.requestId,
          metadata: { from: current.baloOwnerUserId, to: input.ownerUserId },
        },
        tx
      );

      return {
        outcome: 'assigned',
        previousOwnerUserId: current.baloOwnerUserId,
        ownerUserId: input.ownerUserId,
        auditId: auditRow.id,
      };
    });
  },

  /**
   * BAL-540 / ADR-1025 Amendment 1 — CLOSE A REQUEST. THE CASCADE.
   *
   * ONE `db.transaction` that flips the request to the terminal `closed`, declines every live
   * track, withdraws every open proposal, cancels every still-`scheduled` request-grain
   * meeting, revokes every active request-grain representation, and appends ONE
   * `project_request.closed` audit row. Modelled on {@link updateBaloFeeBps} — the shipped
   * "lock FOR UPDATE + write + audit row in ONE transaction" precedent — scaled up.
   *
   * ══ BAL-546 — THE OUTER SERIALIZATION. ═════════════════════════════════════════════
   * This transaction takes the per-request advisory lock (`acquireRequestLock`,
   * `_shared/request-lock.ts`) as the transaction's FIRST LOCK — not literally its first
   * statement (fix round R6; see that file's own docblock for exactly what precedes it).
   * Every `@balo/db` transaction that writes two or more of `proposals` /
   * `request_expert_relationships` / `project_requests` for the SAME request, or inserts an
   * open proposal onto one (fix round R3), takes the identical lock first — ELEVEN writers in
   * total (orchestrator D13):
   * `proposalsRepository.submit`, `.createDraft`, `.promoteToSubmit`, `.accept`, `.resubmit`;
   * this method; `requestExpertRelationshipsRepository.invite`, `.declineTrack`,
   * `.transitionStatus`; `expressionsOfInterestRepository.submit`; and
   * `projectEngagementsRepository.materializeFromKickoff`. Because all of them queue on one
   * per-request gate, no two of them ever interleave their row-lock acquisition on this request —
   * which makes the AB/BA cycle described below UNREACHABLE rather than merely detected-and-
   * retried. Both existing row-lock orders (`accept`'s and `promoteToSubmit`'s) stand unchanged;
   * the cycle they used to form together cannot occur.
   *
   * ⚠ WHAT IS NOT CLAIMED. Not global deadlock-freedom — row locks are still locks. The five
   * writers listed as deliberately OUT of the serialised set (single-row request writers;
   * `proposalsRepository.updateDraft` / `.transitionStatus` / `.requestChanges`;
   * `stampAvailabilityShared`; `expressionsOfInterestRepository.resubmit`;
   * `requestSharedFilesRepository.share`) take trio row locks WITHOUT this advisory lock and can
   * still BLOCK a serialised writer; none can DEADLOCK one, because none of them waits on a
   * second trio row while holding a first. This is a property of the CALLERS, not of the lock,
   * and it stays true only for as long as every new multi-table request-domain writer keeps
   * taking this lock first. D9: there is no read-side gate — a reader must not infer one.
   *
   * ⚠ TWO ADVISORY-LOCK CLASSES NOW EXIST in the data layer (this one and `wallet-lock.ts`'s
   * per-wallet class). They are disjoint: this cascade's money fan-out is provably empty (see
   * below), so no transaction here ever needs both. If one ever does, wallet lock FIRST.
   *
   * ══ LOCK ORDER: PROPOSALS → RELATIONSHIPS → REQUEST. ══════════════════════════════
   * ⚠ THIS IS THE LOAD-BEARING DECISION OF THE WHOLE METHOD and it is a DELIBERATE DEVIATION
   * from the plan's step order (which locked relationships first and reached the proposals at
   * step 7). Both documented orders in this package have to hold at once:
   *   - `proposalsRepository.accept`: "proposal → relationship → request. Any future writer
   *     that locks both must preserve this order to avoid a deadlock cycle."
   *   - `advanceRelationshipStatus`'s LOCK ORDER block: relationship, then request LAST.
   * Reaching the proposals AFTER the relationship rows would have held (relationship, request)
   * while waiting on a proposal that a concurrent `accept` held while waiting on that same
   * relationship — a textbook AB/BA pair. Locking them FIRST satisfies those two rules:
   * proposals, then relationships, then the request LAST. `declineTrack` takes the identical
   * order. Within each set, rows are ordered by `id` so two concurrent cascades queue rather
   * than deadlock.
   *
   * ⚠⚠ THIS USED TO SAY "SATISFIES BOTH RULES IS NOT DEADLOCK-FREE", AND NAMED A FOLLOW-UP
   * TICKET THAT IS NOW THIS ONE. There IS a third documented order in this package, the OPPOSITE
   * of `accept`'s:
   *   - `proposalsRepository.accept`:          proposal → relationship → request
   *   - `proposalsRepository.promoteToSubmit`: relationship → request → proposal
   * Those two never deadlocked EACH OTHER only because they touch DISJOINT proposal statuses —
   * `accept` locks a `submitted` proposal, `promoteToSubmit` a `draft` one. THE CASCADE BRIDGES
   * THOSE WORLDS: `lockOpenProposalsForRequestTx` locks every OPEN proposal at once (`draft` AND
   * `submitted`), which used to complete a live AB/BA cycle against `promoteToSubmit`:
   *
   *     close()          holds: draft proposal P      waits on: relationship R
   *     promoteToSubmit  holds: relationship R        waits on: that same draft P
   *
   * NO SINGLE ROW-LOCK ORDER COULD FIX THIS — there is no ordering of {proposal, relationship,
   * request} that agrees with both `accept` and `promoteToSubmit` at once, because those two
   * disagree with each other. The BAL-546 advisory lock above is the actual fix: it makes the two
   * transactions unable to interleave their row-lock acquisition on this request at all, so the
   * cycle cannot form. Postgres's SQLSTATE 40P01 detection is retained by the four BAL-540 Server
   * Actions (`_actions/_shared/deadlock.ts`) as a cheap backstop over a now much smaller residual
   * (orchestrator D6) — it is not the primary defence any more.
   *
   * ══ THE SEQUENCE, ALL ON ONE `tx` ═════════════════════════════════════════════════
   *   0. BAL-546 — acquire the per-request advisory lock (see above).
   *   1. Lock the request's open proposals (`lockOpenProposalsForRequestTx`, ordered by id) —
   *      the pre-lock SNAPSHOT.
   *   2. Lock its live relationship rows, ordered by id (`lockLiveRelationshipsForRequestTx`) —
   *      the pre-lock SNAPSHOT.
   *   3. Lock the request row. Missing/soft-deleted ⇒ throw.
   *   4. REFUSE, FOR FREE: `isAllowedTransition(current.status, 'closed')`. `STATUS_TRANSITIONS`
   *      gives `closed` no edge from `accepted` / `kickoff_approved` (the AC's refusal) and
   *      `closed: []` makes a second close refuse rather than re-cascade — both through the
   *      existing `InvalidStatusTransitionError`, with nothing written.
   *   5. WRITE THE REQUEST ROW NOW, BEFORE THE CASCADE. ⚠ FIRST, DELIBERATELY: every
   *      `advanceRelationshipStatus` below re-derives the parent status, and with `closed`
   *      already on disk `deriveRequestStatus`'s rule 1 short-circuits — so no intermediate
   *      status can ever be written, not even transiently inside this transaction.
   *   5b. BAL-546 — THE UNION RE-READ. Defence-in-depth against any writer that does NOT take
   *      the advisory lock: re-read both open sets NOW, under the request lock, and act on the
   *      UNION of the pre-lock snapshot and this re-read (`unionById`, deduplicated by `id` —
   *      see its own docblock for why the dedupe is load-bearing, not tidiness). See §"THE UNION
   *      RE-READ IS NOT LOCK-ORDER-NEUTRAL" below for the safety argument this depends on.
   *   6. Meetings. `project_discovery`@requestId ∪ `request_interaction`@each-relationship-id,
   *      in ONE batched read, then `cancelMeetingTx` per meeting.
   *   7. Tracks → `declined`, reason `request_closed` (each writes its own audit row).
   *   8. Proposals → `withdrawn` (NOT `declined`: the request ended, nobody judged them).
   *   9. Request-grain representations → `revoked`.
   *  10. The `project_request.closed` audit row, LAST — an audit row must never outlive a
   *      rolled-back close.
   *
   * ⚠⚠ THE UNION RE-READ IS NOT LOCK-ORDER-NEUTRAL, AND A SENTENCE THAT USED TO CLAIM OTHERWISE
   * IS DELETED, NOT SUPPLEMENTED (orchestrator D14). Rows found only by the re-read take their
   * proposal row lock (via the re-read's own `FOR UPDATE`, and again inside
   * `advanceProposalStatus`) and their relationship row lock AFTER the request lock — inverting
   * BOTH `accept`'s documented "proposal → relationship → request" order AND
   * `advanceRelationshipStatus`'s "relationship FIRST, request LAST" rule. The re-read is safe
   * ONLY because the advisory lock above is held for the whole transaction and every serialised
   * writer takes it first. The two parts — the advisory lock and this re-read — ship together and
   * must never be separated: shipping the re-read alone would introduce a NEW AB/BA class.
   *
   * ⚠⚠ NEVER CALL A REPOSITORY METHOD THAT OPENS ITS OWN `db.transaction` FROM IN HERE
   * (orchestrator D4). `meetingsRepository.cancel`, `proposalsRepository.transitionStatus` and
   * `requestExpertRelationshipsRepository.transitionStatus` all do; in PRODUCTION each would
   * take a SECOND pooled connection and commit INDEPENDENTLY of this close. ⚠ AND NO RUNTIME
   * TEST CAN CATCH IT: the integration harness swaps `db` for the outer transaction
   * (`test/setup-integration.ts`), so a nested call becomes a SAVEPOINT and the suite stays
   * GREEN. Everything above therefore takes the `tx` explicitly, and the mechanical guard is
   * `invariants/close-cascade-opens-one-transaction.test.ts`.
   *
   * ⚠ THE MONEY FAN-OUT IS PROVABLY EMPTY, and it is asserted rather than merely asserted-in-
   * prose. `openCaseSessionBestEffort` early-returns unless `contextType === 'case'`
   * (`apps/api/src/services/meetings/join-meeting.ts`), so a `project_discovery` /
   * `request_interaction` meeting NEVER carries a credit session or a hold. No hold release, no
   * settlement, no concealment — pinned by `project-request-close.integration.test.ts`.
   *
   * ⚠ ONLY `scheduled` MEETINGS ARE CANCELLED (orchestrator D1). `CANCELLABLE_MEETING_STATUSES`
   * stays `['scheduled']` and is NOT widened, and no cascade-only status set is created. KNOWN,
   * DELIBERATE RESIDUAL: a request-grain call somebody has already JOINED
   * (`waiting_for_participants`) SURVIVES the close and is ended by the lifecycle sweep
   * instead. ADR-1025 Amendment 1's "`scheduled` / `waiting_for_participants`" wording is wrong
   * and needs correcting.
   *
   * ⚠ THIS REPOSITORY NOTIFIES NOBODY, and cannot (`invariants/repositories-never-notify.test.ts`).
   * The caller owns the POST-COMMIT fan-out: the Daily room teardown + availability-cache
   * rebuild for each returned `cancelledMeetings` entry, and the `project.request_closed`
   * publish. Everything that fan-out needs is in the result, including the per-WRITE,
   * colon-free `closeAuditId` / `declineAuditId` / `cancelAuditId` correlation ids — AND the
   * resolved `declinedTrackUserIds` (step 7b). That last one is deliberate: the fan-out runs
   * in `runAfterResponse`, which has NO RETRY, so any read it still had to do post-commit was
   * a permanent way to lose the expert notices on a close that had already landed. It now has
   * none.
   *
   * ⚠ THE RESIDUALS NAMED BELOW ARE CLOSED FOR EVERY WRITER IN THE SERIALISED SET (BAL-546). The
   * two paragraphs below used to describe an OPEN race — a relationship or proposal committed
   * between this cascade's pre-lock snapshot and the request lock, surviving un-declined /
   * un-withdrawn. That race is now closed by the combination of (a) the advisory lock, which
   * every serialised writer (`invite`, `submit`, `resubmit`, `promoteToSubmit`, …) takes before
   * this cascade can proceed past its own lock acquisition, and (b) the union re-read (step 5b
   * above), which catches anything committed by a writer that does not take the lock. The
   * history is kept below because it explains WHY the union re-read exists; read it as CLOSED,
   * not as a live residual.
   *
   * `invite()` is guarded against a closed request (it refuses under the request lock,
   * `RequestClosedError`), and the request can never un-close (derivation rule 1) — so before
   * BAL-546 it took an admin invite landing inside a narrow window between this cascade's step-2
   * snapshot and COMMIT for a relationship to slip through un-declined, which left the invited
   * expert resolved to the `expert` participant lens (brief + client contact + LIVE file access)
   * on a request that was supposed to be terminal, even though booking and re-opening stayed
   * refused. The union re-read closes this: a relationship committed after the snapshot is caught
   * by the post-lock re-read and declined in the same pass as everything else.
   *
   * The identical shape existed for proposals: `resubmit()` (orchestrator D3 — not `submit()`,
   * which has zero production callers) is INSERT-based, so a proposal it committed between step
   * 1's snapshot and this cascade winning the relationship/request locks used to survive the
   * close UN-WITHDRAWN — inert (`accept()` refuses via the relationship's `expectedFrom`, and
   * booking refuses because the request is `closed`) but CLIENT-VISIBLE. The union re-read closes
   * this the same way. `createDraft` also now takes the advisory lock (D7), closing the
   * autosave-race half from the writer side as well as the `ProposalTrackNotOpenError` guard
   * closing the post-commit half.
   *
   * Throws `InvalidStatusTransitionError` (already closed, or past `proposal_submitted`) and
   * `Error` for a missing/soft-deleted request. Nothing is written on either.
   */
  async close(input: CloseRequestInput): Promise<CloseRequestResult> {
    return db.transaction(async (tx) => {
      // 0. BAL-546 — the per-request advisory lock, the transaction's FIRST LOCK (R6).
      await acquireRequestLock(tx, input.requestId);

      const now = new Date();

      // 1. PROPOSAL ROWS FIRST — see the LOCK ORDER block. Pre-lock SNAPSHOT (re-read at 5b).
      const snapshotProposals = await lockOpenProposalsForRequestTx(tx, input.requestId);

      // 2. Relationship rows, ordered by id (two concurrent cascades queue, never deadlock).
      //    Pre-lock SNAPSHOT (re-read at 5b).
      const snapshotRelationships = await lockLiveRelationshipsForRequestTx(tx, input.requestId);

      // 3. The request row LAST among the locks.
      const [current] = await tx
        .select()
        .from(projectRequests)
        .where(and(eq(projectRequests.id, input.requestId), isNull(projectRequests.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Project request not found: ${input.requestId}`);
      }

      // 4. Refuse, for free.
      if (!isAllowedTransition(current.status, 'closed')) {
        throw new InvalidStatusTransitionError(current.status, 'closed');
      }
      const previousStatus = current.status;

      // 5. Write the request row NOW — before anything re-derives it.
      const [updated] = await tx
        .update(projectRequests)
        .set({
          status: 'closed',
          closedAt: now,
          closedByUserId: input.actorUserId,
          closeReason: input.reason,
          closeNote: input.note,
        })
        .where(eq(projectRequests.id, input.requestId))
        .returning();

      if (updated === undefined) {
        throw new Error(`Failed to update project request: ${input.requestId}`);
      }

      // 5b. UNION RE-READ (BAL-546). Steps 1 and 2 snapshotted BEFORE this transaction owned the
      //     request row. Re-read both id sets now that the request lock is held and act on the
      //     UNION — see the docblock for why this is defence-in-depth, and why it is safe ONLY
      //     because the advisory lock is held for the whole transaction.
      const reReadProposals = await lockOpenProposalsForRequestTx(tx, input.requestId);
      const reReadRelationships = await lockLiveRelationshipsForRequestTx(tx, input.requestId);

      const openProposals = unionById(snapshotProposals, reReadProposals);
      const relationships = unionById(snapshotRelationships, reReadRelationships);

      // 6. Meetings. `project_discovery` is keyed on the REQUEST; `request_interaction` on
      //    each RELATIONSHIP (`@balo/shared/meetings/context-owner.ts`) — hence the batch.
      const actorRole = input.actorKind === 'balo' ? 'admin' : 'client';
      const liveMeetings = await meetingContextsRepository.listMeetingsForContexts(
        [
          { contextType: 'project_discovery', contextId: input.requestId },
          ...relationships.map((relationship) => ({
            contextType: 'request_interaction' as const,
            contextId: relationship.id,
          })),
        ],
        tx
      );

      const cancelledMeetings: CloseRequestResult['cancelledMeetings'] = [];
      for (const row of liveMeetings) {
        const cancelled = await cancelMeetingTx(tx, row.meeting.id, {
          actorUserId: input.actorUserId,
          actorRole,
        });
        // `undefined` ⇒ the CAS missed: the meeting is not `scheduled` (D1's residual — it has
        // been joined, or was already cancelled/ended). SKIP it; never widen the CAS.
        if (cancelled !== undefined) {
          cancelledMeetings.push({
            meetingId: cancelled.meeting.id,
            expertProfileId: cancelled.expertProfileId,
            cancelAuditId: cancelled.cancelAuditId,
          });
        }
      }

      // 7. Tracks. `accepted` and `declined` have no `declined` edge, so a terminal track is
      //    skipped rather than throwing — and step 4 already made an `accepted` track
      //    unreachable (a track only reaches `accepted` by advancing the request there too).
      const declinedTracks: CloseRequestResult['declinedTracks'] = [];
      for (const relationship of relationships) {
        if (!isAllowedRelationshipTransition(relationship.status, 'declined')) {
          continue;
        }
        const advanced = await advanceRelationshipStatus(tx, {
          id: relationship.id,
          to: 'declined',
          actorUserId: input.actorUserId,
          reason: 'request_closed',
        });
        declinedTracks.push({
          relationshipId: relationship.id,
          expertProfileId: relationship.expertProfileId,
          previousStatus: advanced.previousStatus,
          declineAuditId: advanced.auditId,
        });
      }

      // 7b. The expert USER ids behind those tracks — resolved HERE, in-transaction, so the
      //     post-commit fan-out has NO read left that can fail (see `declinedTrackUserIds`).
      //     A PLAIN read on `expert_profiles` ⋈ `users`: it takes no row lock, so it adds no
      //     edge to the LOCK ORDER block's sequence and cannot introduce a deadlock class.
      const declinedTrackUserIds = await resolveExpertUserIdsTx(
        tx,
        declinedTracks.map((track) => track.expertProfileId)
      );

      // 8. Proposals → `withdrawn`. Already locked in step 1; `advanceProposalStatus` re-takes
      //    the row lock for free and still runs its transition guard.
      const withdrawnProposalIds: string[] = [];
      for (const proposal of openProposals) {
        await advanceProposalStatus(tx, { id: proposal.id, to: 'withdrawn' });
        withdrawnProposalIds.push(proposal.id);
      }

      // 9. Request-grain representations. Scoped by company as well as request id (IDOR
      //    containment); sourced from the LOCKED request row, never from the wire.
      const revokedRepresentationIds = await representationsRepository.revokeAllForRequest(
        {
          projectRequestId: input.requestId,
          onBehalfOfCompanyId: current.companyId,
          revokedByUserId: input.actorUserId,
        },
        now,
        tx
      );

      // 10. The audit row, LAST.
      //
      // ⚠ FIXED METADATA CONTRACT. `audit_events` is APPEND-ONLY — no `updated_at`, no
      // backfill — so this shape is unrecoverable if wrong (`_shared/request-file-audit.ts`'s
      // rule). It is asserted key-by-key in `project-request-close.integration.test.ts`.
      //
      // ⚠ `hasNote`, NEVER THE NOTE TEXT. `close_note` is staff-only and the column is its
      // ONLY home; copying it here would put it in a row that admin-history reads render.
      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'project_request.closed',
          entityType: 'project_request',
          entityId: input.requestId,
          metadata: {
            reason: input.reason,
            actorKind: input.actorKind,
            previousStatus,
            hasNote: input.note !== null,
            counts: {
              tracksDeclined: declinedTracks.length,
              proposalsWithdrawn: withdrawnProposalIds.length,
              meetingsCancelled: cancelledMeetings.length,
              representationsRevoked: revokedRepresentationIds.length,
            },
            declinedRelationshipIds: declinedTracks.map((track) => track.relationshipId),
            cancelledMeetingIds: cancelledMeetings.map((meeting) => meeting.meetingId),
          },
        },
        tx
      );

      return {
        request: updated,
        previousStatus,
        closeAuditId: auditRow.id,
        declinedTracks,
        declinedTrackUserIds,
        withdrawnProposalIds,
        cancelledMeetings,
        revokedRepresentationIds,
      };
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
