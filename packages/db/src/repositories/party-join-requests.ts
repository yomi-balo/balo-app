import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../client';
import {
  partyJoinRequests,
  users,
  type PartyJoinRequest,
  type PartyJoinRequestStatus,
  type PartyType,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';
import { partyMembershipsRepository, type FindOrCreateMembershipResult } from './party-memberships';

/**
 * party-join-requests (BAL-345) — the request lifecycle for `domainJoinMode =
 * 'request'`. Mirrors `engagements.ts`: a `Record` transition map +
 * `isAllowed*Transition` guard + typed `Invalid*TransitionError` + a shared
 * `advance*Status(tx, …)` writer (FOR UPDATE + `expectedFrom`) composable inside
 * any caller's transaction. Approving materialises the membership in the SAME tx.
 */

// ── Transitions ───────────────────────────────────────────────────────────

/**
 * Allowed join-request status transitions. Only `pending` is non-terminal.
 * Ordering carries no semantics — this map is the single source of truth.
 */
export const PARTY_JOIN_REQUEST_STATUS_TRANSITIONS: Record<
  PartyJoinRequestStatus,
  readonly PartyJoinRequestStatus[]
> = {
  pending: ['approved', 'declined', 'withdrawn'],
  approved: [],
  declined: [],
  withdrawn: [],
};

export function isAllowedJoinRequestTransition(
  from: PartyJoinRequestStatus,
  to: PartyJoinRequestStatus
): boolean {
  return PARTY_JOIN_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

export class InvalidJoinRequestTransitionError extends Error {
  constructor(
    public readonly from: PartyJoinRequestStatus,
    public readonly to: PartyJoinRequestStatus
  ) {
    super(`Invalid party join request status transition: ${from} → ${to}`);
    this.name = 'InvalidJoinRequestTransitionError';
  }
}

/**
 * Shared transition writer. Locks the LIVE request FOR UPDATE, validates against
 * the transition map (+ optional `expectedFrom`), applies `{ status: to, ...set }`,
 * returns the row. Exact `advanceEngagementStatus` shape. Threaded with
 * `DbExecutor` (a live tx in practice — FOR UPDATE only locks inside a tx) so it
 * composes inside a caller's transaction atomically with the audit write. Throws
 * `InvalidJoinRequestTransitionError` for illegal moves / `expectedFrom` mismatch,
 * `Error` for a missing/soft-deleted request.
 */
export async function advanceJoinRequestStatus(
  tx: DbExecutor,
  input: {
    id: string;
    to: PartyJoinRequestStatus;
    expectedFrom?: PartyJoinRequestStatus;
    set?: Partial<typeof partyJoinRequests.$inferInsert>;
  }
): Promise<PartyJoinRequest> {
  const [current] = await tx
    .select()
    .from(partyJoinRequests)
    .where(and(eq(partyJoinRequests.id, input.id), isNull(partyJoinRequests.deletedAt)))
    .for('update');

  if (current === undefined) {
    throw new Error(`Party join request not found: ${input.id}`);
  }

  if (input.expectedFrom !== undefined && current.status !== input.expectedFrom) {
    throw new InvalidJoinRequestTransitionError(current.status, input.to);
  }

  if (!isAllowedJoinRequestTransition(current.status, input.to)) {
    throw new InvalidJoinRequestTransitionError(current.status, input.to);
  }

  const [updated] = await tx
    .update(partyJoinRequests)
    .set({ status: input.to, ...input.set })
    .where(eq(partyJoinRequests.id, input.id))
    .returning();

  if (updated === undefined) {
    throw new Error(`Failed to update party join request: ${input.id}`);
  }

  return updated;
}

// ── Private helpers ─────────────────────────────────────────────────────

/** The LIVE pending request for (party, user), or undefined. */
async function findPendingRow(
  exec: DbExecutor,
  partyType: PartyType,
  partyId: string,
  userId: string
): Promise<PartyJoinRequest | undefined> {
  const [row] = await exec
    .select()
    .from(partyJoinRequests)
    .where(
      and(
        eq(partyJoinRequests.partyType, partyType),
        eq(partyJoinRequests.partyId, partyId),
        eq(partyJoinRequests.userId, userId),
        eq(partyJoinRequests.status, 'pending'),
        isNull(partyJoinRequests.deletedAt)
      )
    )
    .limit(1);
  return row;
}

/**
 * Advance a pending request to a terminal NON-approved status (`declined` /
 * `withdrawn`) + audit, self-wrapping or composing in the caller's tx. Shared by
 * both `decline` and `withdraw` (their ONLY difference is the target status) so
 * the two public methods are single-expression wrappers, not copy-paste clones.
 * `approve` is separate (it also materialises a membership).
 */
async function resolvePending(
  input: ResolveRequestInput,
  to: 'declined' | 'withdrawn',
  exec?: DbExecutor
): Promise<{ request: PartyJoinRequest }> {
  const run = async (tx: DbExecutor): Promise<{ request: PartyJoinRequest }> => {
    const request = await advanceJoinRequestStatus(tx, {
      id: input.requestId,
      to,
      expectedFrom: 'pending',
      set: { resolvedByUserId: input.actorUserId, resolvedAt: new Date() },
    });
    await auditEventsRepository.record(
      {
        actorUserId: input.actorUserId,
        action: `party_join_request.${to}`,
        entityType: 'party_join_request',
        entityId: request.id,
        metadata: {
          partyType: request.partyType,
          partyId: request.partyId,
          userId: request.userId,
          from: 'pending',
          to,
        },
      },
      tx
    );
    return { request };
  };
  return exec ? run(exec) : db.transaction(run);
}

// ── Result types ──────────────────────────────────────────────────────────

export type FindOrCreatePendingResult =
  | { outcome: 'created'; request: PartyJoinRequest }
  | { outcome: 'already_pending'; request: PartyJoinRequest };

export interface CreatePendingInput {
  partyType: PartyType;
  partyId: string;
  userId: string;
}

export interface ResolveRequestInput {
  requestId: string;
  actorUserId: string;
}

/**
 * A pending join-request row hydrated with the requester's name + email (BAL-347
 * admin queue). `email` is load-bearing (the admin identifies the requester by it);
 * only requester fields are projected — no resolver, no other PII.
 */
export interface PendingJoinRequestRow {
  id: string;
  createdAt: Date;
  requester: { id: string; firstName: string | null; lastName: string | null; email: string };
}

/**
 * A resolved (approved/declined/withdrawn) join-request row for the collapsed
 * history disclosure (BAL-347). `resolver` is the admin who approved/declined it, and
 * is `null` for a withdrawn row: a self-withdraw stamps `resolved_by_user_id` with the
 * requester (for audit), but there is no admin resolver to surface. Only names are projected.
 */
export interface ResolvedJoinRequestRow {
  id: string;
  status: 'approved' | 'declined' | 'withdrawn';
  resolvedAt: Date | null;
  requester: { firstName: string | null; lastName: string | null; email: string };
  resolver: { firstName: string | null; lastName: string | null } | null;
}

// ── Public repository ─────────────────────────────────────────────────────

export const partyJoinRequestsRepository = {
  /**
   * Idempotent find-or-create of the LIVE pending request for (party, user).
   * `INSERT ... ON CONFLICT DO NOTHING` on the `party_join_requests_pending_unique_idx`
   * arbiter (predicate `status = 'pending' AND deleted_at IS NULL` — mirrors the
   * index verbatim): a returned row → audit `party_join_request.created` → `created`;
   * a conflict → re-SELECT the live pending row → `already_pending` (double-submit /
   * BullMQ-retry safe). A prior terminal (declined/withdrawn) row does NOT block a
   * fresh request — it is outside the partial index.
   */
  findOrCreatePending: async (
    input: CreatePendingInput,
    exec?: DbExecutor
  ): Promise<FindOrCreatePendingResult> => {
    const run = async (tx: DbExecutor): Promise<FindOrCreatePendingResult> => {
      const [inserted] = await tx
        .insert(partyJoinRequests)
        .values({ partyType: input.partyType, partyId: input.partyId, userId: input.userId })
        .onConflictDoNothing({
          target: [
            partyJoinRequests.partyType,
            partyJoinRequests.partyId,
            partyJoinRequests.userId,
          ],
          where: sql`${partyJoinRequests.status} = 'pending' AND ${partyJoinRequests.deletedAt} IS NULL`,
        })
        .returning();

      if (inserted !== undefined) {
        await auditEventsRepository.record(
          {
            actorUserId: input.userId,
            action: 'party_join_request.created',
            entityType: 'party_join_request',
            entityId: inserted.id,
            metadata: {
              partyType: input.partyType,
              partyId: input.partyId,
              userId: input.userId,
            },
          },
          tx
        );
        return { outcome: 'created', request: inserted };
      }

      const existing = await findPendingRow(tx, input.partyType, input.partyId, input.userId);
      if (existing === undefined) {
        throw new Error('findOrCreatePending: conflict but no live pending request found');
      }
      return { outcome: 'already_pending', request: existing };
    };
    return exec ? run(exec) : db.transaction(run);
  },

  /**
   * Approve a pending request AND materialise the membership in ONE tx: advance
   * `pending → approved` (stamping resolver + resolvedAt), find-or-create the
   * `domain_match` membership, audit `party_join_request.approved`. Request flip +
   * membership create + both audits commit or roll back together.
   */
  approve: async (
    input: ResolveRequestInput,
    exec?: DbExecutor
  ): Promise<{ request: PartyJoinRequest; membership: FindOrCreateMembershipResult }> => {
    const run = async (
      tx: DbExecutor
    ): Promise<{ request: PartyJoinRequest; membership: FindOrCreateMembershipResult }> => {
      const request = await advanceJoinRequestStatus(tx, {
        id: input.requestId,
        to: 'approved',
        expectedFrom: 'pending',
        set: { resolvedByUserId: input.actorUserId, resolvedAt: new Date() },
      });
      const membership = await partyMembershipsRepository.findOrCreateDomainMembership(
        {
          partyType: request.partyType,
          partyId: request.partyId,
          userId: request.userId,
          actorUserId: input.actorUserId,
        },
        tx
      );
      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'party_join_request.approved',
          entityType: 'party_join_request',
          entityId: request.id,
          metadata: {
            partyType: request.partyType,
            partyId: request.partyId,
            userId: request.userId,
            from: 'pending',
            to: 'approved',
            membershipId: membership.membershipId,
            membershipOutcome: membership.outcome,
          },
        },
        tx
      );
      return { request, membership };
    };
    return exec ? run(exec) : db.transaction(run);
  },

  /** Decline a pending request (`pending → declined`) + audit. No membership. */
  decline: async (
    input: ResolveRequestInput,
    exec?: DbExecutor
  ): Promise<{ request: PartyJoinRequest }> => resolvePending(input, 'declined', exec),

  /**
   * Withdraw a pending request (`pending → withdrawn`) + audit. Actor = the
   * requester (self); the caller asserts `request.userId === session.id`.
   */
  withdraw: async (
    input: ResolveRequestInput,
    exec?: DbExecutor
  ): Promise<{ request: PartyJoinRequest }> => resolvePending(input, 'withdrawn', exec),

  /**
   * The live request by id (any status), or undefined. Used by the approve/decline
   * Server Actions to load `partyType`/`partyId`/`userId` for the capability gate
   * BEFORE mutating — the authz check must read the request's own party scope, and
   * `approve`/`decline` only lock the row internally (too late to gate on).
   */
  findById: async (id: string, exec?: DbExecutor): Promise<PartyJoinRequest | undefined> => {
    const [row] = await (exec ?? db)
      .select()
      .from(partyJoinRequests)
      .where(and(eq(partyJoinRequests.id, id), isNull(partyJoinRequests.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * The live pending request for (party, user), or undefined. Accepts `exec` so
   * the escape-hatch orchestrator can read it inside its single tx. Used for
   * escape-hatch branching + idempotency reads.
   */
  findPendingByUserAndParty: async (
    partyType: PartyType,
    partyId: string,
    userId: string,
    exec?: DbExecutor
  ): Promise<PartyJoinRequest | undefined> => {
    return findPendingRow(exec ?? db, partyType, partyId, userId);
  },

  /**
   * Pending requests for a party, hydrated with the requester (name + email),
   * oldest-first (BAL-347 admin queue). `party_join_requests` has NO relations block
   * so this uses an explicit INNER JOIN on `users` with a PROJECTED select (no PII
   * beyond the load-bearing email). Excludes soft-deleted / non-pending rows.
   */
  listPendingByParty: async (
    partyType: PartyType,
    partyId: string
  ): Promise<PendingJoinRequestRow[]> => {
    return db
      .select({
        id: partyJoinRequests.id,
        createdAt: partyJoinRequests.createdAt,
        requester: {
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        },
      })
      .from(partyJoinRequests)
      .innerJoin(users, eq(users.id, partyJoinRequests.userId))
      .where(
        and(
          eq(partyJoinRequests.partyType, partyType),
          eq(partyJoinRequests.partyId, partyId),
          eq(partyJoinRequests.status, 'pending'),
          isNull(partyJoinRequests.deletedAt)
        )
      )
      .orderBy(asc(partyJoinRequests.createdAt));
  },

  /**
   * Resolved (approved/declined/withdrawn) requests for a party, most-recently
   * resolved first (BAL-347 collapsed history). INNER JOIN the requester + LEFT JOIN
   * an ALIASED `users` for the resolver. Projected columns only; `resolver` collapses
   * to `null` for withdrawn rows (a self-withdraw has no admin resolver) and whenever
   * `resolved_by_user_id` is unset.
   */
  listResolvedByParty: async (
    partyType: PartyType,
    partyId: string,
    limit = 20
  ): Promise<ResolvedJoinRequestRow[]> => {
    const resolver = alias(users, 'resolver');
    const rows = await db
      .select({
        id: partyJoinRequests.id,
        status: partyJoinRequests.status,
        resolvedAt: partyJoinRequests.resolvedAt,
        requesterFirstName: users.firstName,
        requesterLastName: users.lastName,
        requesterEmail: users.email,
        resolverId: resolver.id,
        resolverFirstName: resolver.firstName,
        resolverLastName: resolver.lastName,
      })
      .from(partyJoinRequests)
      .innerJoin(users, eq(users.id, partyJoinRequests.userId))
      .leftJoin(resolver, eq(resolver.id, partyJoinRequests.resolvedByUserId))
      .where(
        and(
          eq(partyJoinRequests.partyType, partyType),
          eq(partyJoinRequests.partyId, partyId),
          inArray(partyJoinRequests.status, ['approved', 'declined', 'withdrawn']),
          isNull(partyJoinRequests.deletedAt)
        )
      )
      // resolvedAt is always set for a resolved row; NULLS LAST is defence-in-depth.
      .orderBy(sql`${partyJoinRequests.resolvedAt} DESC NULLS LAST`)
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      // The WHERE clause guarantees a non-pending status; narrow for the DTO.
      status: row.status as 'approved' | 'declined' | 'withdrawn',
      resolvedAt: row.resolvedAt,
      requester: {
        firstName: row.requesterFirstName,
        lastName: row.requesterLastName,
        email: row.requesterEmail,
      },
      // A self-withdrawal has no admin resolver: `resolved_by_user_id` records the
      // requester (for audit), but we surface `resolver: null` so the collapsed history
      // never renders the requester as their own resolver.
      resolver:
        row.status === 'withdrawn' || row.resolverId === null
          ? null
          : { firstName: row.resolverFirstName, lastName: row.resolverLastName },
    }));
  },
};
