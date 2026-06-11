import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  proposals,
  proposalChangeRequests,
  type Proposal,
  type ProposalChangeRequest,
} from '../schema';
import { advanceRelationshipStatus } from './request-expert-relationships';
import type { PricingMethod, ProposalCadence, ProposalChangeSection } from './proposal-types';

export type ProposalStatus = Proposal['status'];

/**
 * Allowed proposal status transitions (A6 / BAL-287).
 *
 *   draft             → submitted | withdrawn      (composer "Submit" / discard)
 *   submitted         → accepted | changes_requested | withdrawn
 *   changes_requested → resubmitted | withdrawn    (the act of resubmitting / pull)
 *   resubmitted       → []  terminal for the OLD row (the new version is a fresh
 *                           `submitted` row inserted by `resubmit`)
 *   accepted          → []  terminal
 *   withdrawn         → []  terminal
 *
 * `withdrawn` is reachable from any non-terminal active state. `draft` exists in
 * the enum + map for A6.2's saveDraft/submitDraft — A6.1 `submit()` inserts
 * directly as `submitted`.
 */
export const PROPOSAL_STATUS_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['accepted', 'changes_requested', 'withdrawn'],
  changes_requested: ['resubmitted', 'withdrawn'],
  resubmitted: [],
  accepted: [],
  withdrawn: [],
};

export function isAllowedProposalTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_STATUS_TRANSITIONS[from].includes(to);
}

export class InvalidProposalTransitionError extends Error {
  constructor(
    public readonly from: ProposalStatus,
    public readonly to: ProposalStatus
  ) {
    super(`Invalid proposal status transition: ${from} → ${to}`);
    this.name = 'InvalidProposalTransitionError';
  }
}

/**
 * Shared transition implementation. Locks the live proposal row FOR UPDATE,
 * validates against `PROPOSAL_STATUS_TRANSITIONS`, stamps side-columns
 * (`acceptedAt` when advancing to `accepted`), then persists. Exported so
 * cross-table writers (accept, requestChanges) can advance the proposal inside
 * their own transaction atomically with their content write — mirrors
 * `advanceRelationshipStatus`.
 *
 * `tx` is the active transaction. Throws `InvalidProposalTransitionError` for
 * illegal moves / `expectedFrom` mismatch and `Error` for a missing/soft-deleted
 * proposal.
 */
export async function advanceProposalStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    id: string;
    to: ProposalStatus;
    expectedFrom?: ProposalStatus;
  }
): Promise<Proposal> {
  const [current] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, input.id), isNull(proposals.deletedAt)))
    .for('update');

  if (current === undefined) {
    throw new Error(`Proposal not found: ${input.id}`);
  }

  if (input.expectedFrom !== undefined && current.status !== input.expectedFrom) {
    throw new InvalidProposalTransitionError(current.status, input.to);
  }

  if (!isAllowedProposalTransition(current.status, input.to)) {
    throw new InvalidProposalTransitionError(current.status, input.to);
  }

  const [updated] = await tx
    .update(proposals)
    .set({
      status: input.to,
      ...(input.to === 'accepted' ? { acceptedAt: new Date() } : {}),
    })
    .where(eq(proposals.id, input.id))
    .returning();

  if (updated === undefined) {
    throw new Error(`Failed to update proposal: ${input.id}`);
  }

  return updated;
}

export const proposalsRepository = {
  /**
   * Expert submits a proposal for a relationship. In ONE transaction: insert the
   * proposal (status `submitted`, `version` 1, `is_current` true) AND advance the
   * relationship `proposal_requested`→`proposal_submitted`. Denormalised
   * request/expert ids are read FROM the (locked) relationship row, not trusted
   * from the caller.
   *
   * Carries the full proposal header (A6.2 submits a complete proposal through it):
   * `overview` + `pricingMethod` + `priceCents` + optional `currency`,
   * `timeframeWeeks`, `exclusions`, and the T&M fields
   * `depositCents`/`rateCents`/`cadence`. Milestones / installments / documents are
   * written via their own repos (separate calls), NOT inside `submit()`.
   * `priceCents` is integer minor units; `currency` defaults to `aud`.
   *
   * BOUNDARY: does NOT advance request-level status — caller-owned. Draft
   * persistence (insert as `draft`) is A6.2; this inserts directly as `submitted`.
   */
  async submit(input: {
    relationshipId: string;
    overview: string;
    pricingMethod: PricingMethod;
    priceCents: number;
    currency?: string;
    timeframeWeeks?: number;
    exclusions?: string;
    depositCents?: number;
    rateCents?: number;
    cadence?: ProposalCadence;
  }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      const relationship = await advanceRelationshipStatus(tx, {
        id: input.relationshipId,
        to: 'proposal_submitted',
        expectedFrom: 'proposal_requested',
      });

      const [row] = await tx
        .insert(proposals)
        .values({
          relationshipId: relationship.id,
          projectRequestId: relationship.projectRequestId,
          expertProfileId: relationship.expertProfileId,
          status: 'submitted',
          version: 1,
          isCurrent: true,
          overview: input.overview,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          currency: input.currency,
          timeframeWeeks: input.timeframeWeeks,
          exclusions: input.exclusions,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create proposal');
      }
      return row;
    });
  },

  /** Live proposal by id. */
  async findById(id: string): Promise<Proposal | undefined> {
    return db.query.proposals.findFirst({
      where: and(eq(proposals.id, id), isNull(proposals.deletedAt)),
    });
  },

  /** All live proposals for a request, newest-submitted first. */
  async listByRequest(projectRequestId: string): Promise<Proposal[]> {
    return db
      .select()
      .from(proposals)
      .where(and(eq(proposals.projectRequestId, projectRequestId), isNull(proposals.deletedAt)))
      .orderBy(desc(proposals.submittedAt));
  },

  /** All live proposals for a relationship, oldest-submitted first (revision order). */
  async listByRelationship(relationshipId: string): Promise<Proposal[]> {
    return db
      .select()
      .from(proposals)
      .where(and(eq(proposals.relationshipId, relationshipId), isNull(proposals.deletedAt)))
      .orderBy(asc(proposals.submittedAt));
  },

  /** The current (`is_current`) live proposal for a relationship, or undefined. */
  async findCurrentByRelationship(relationshipId: string): Promise<Proposal | undefined> {
    return db.query.proposals.findFirst({
      where: and(
        eq(proposals.relationshipId, relationshipId),
        eq(proposals.isCurrent, true),
        isNull(proposals.deletedAt)
      ),
    });
  },

  /**
   * Client accepts a proposal. In ONE transaction: proposal status→`accepted`
   * (routed through `advanceProposalStatus`, which validates submitted→accepted
   * and stamps `acceptedAt`) AND relationship `proposal_submitted`→`accepted`.
   *
   * BOUNDARY: does NOT touch request-level status and creates NO
   * delivery/engagement record (A6.5 owns that). The method's scope is exactly
   * these two updates.
   *
   * LOCK ORDER: proposal row first (FOR UPDATE), then the relationship row (via
   * `advanceRelationshipStatus`). Any future writer that locks both must preserve
   * this order to avoid a deadlock cycle.
   */
  async accept(input: { id: string }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      // Lock the proposal first and capture its relationship id (also validates
      // the proposal is live + currently `submitted` before we touch the spine).
      const [current] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, input.id), isNull(proposals.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Proposal not found: ${input.id}`);
      }
      if (!isAllowedProposalTransition(current.status, 'accepted')) {
        throw new InvalidProposalTransitionError(current.status, 'accepted');
      }

      // Advance the relationship (locks + validates the spine state).
      await advanceRelationshipStatus(tx, {
        id: current.relationshipId,
        to: 'accepted',
        expectedFrom: 'proposal_submitted',
      });

      // Proposal status write goes THROUGH the guarded transition writer.
      return advanceProposalStatus(tx, {
        id: input.id,
        to: 'accepted',
        expectedFrom: 'submitted',
      });
    });
  },

  /**
   * Guarded proposal status write. Wraps `advanceProposalStatus` in its own
   * transaction. Throws `InvalidProposalTransitionError` for illegal moves /
   * `expectedFrom` mismatch.
   */
  async transitionStatus(input: {
    id: string;
    to: ProposalStatus;
    expectedFrom?: ProposalStatus;
  }): Promise<Proposal> {
    return db.transaction((tx) => advanceProposalStatus(tx, input));
  },

  /**
   * Client requests changes on a proposal. In ONE transaction: advance
   * `submitted`→`changes_requested` (via `advanceProposalStatus`) AND insert a
   * `proposal_change_requests` row whose `proposalVersion` is the LOCKED
   * proposal's version (so the change reads correctly against the right version
   * after a later resubmit). Returns the change request.
   *
   * Throws `InvalidProposalTransitionError` if the proposal isn't `submitted`.
   * Locks only the proposal (no relationship transition — it is already
   * `proposal_submitted`).
   */
  async requestChanges(input: {
    proposalId: string;
    requestedByUserId: string;
    section?: ProposalChangeSection;
    note: string;
  }): Promise<ProposalChangeRequest> {
    return db.transaction(async (tx) => {
      const advanced = await advanceProposalStatus(tx, {
        id: input.proposalId,
        to: 'changes_requested',
        expectedFrom: 'submitted',
      });

      const [row] = await tx
        .insert(proposalChangeRequests)
        .values({
          proposalId: input.proposalId,
          requestedByUserId: input.requestedByUserId,
          note: input.note,
          proposalVersion: advanced.version,
          section: input.section,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create proposal change request');
      }
      return row;
    });
  },

  /**
   * Expert resubmits a revised proposal — creates v(n+1) while keeping history.
   * In ONE transaction, STRICT order (the partial unique index
   * `proposal_current_per_relationship_idx WHERE deleted_at IS NULL AND
   * is_current` makes "two current proposals per relationship" physically
   * impossible — so order is load-bearing):
   *
   *   1. Lock the current proposal FOR UPDATE
   *      (`relationshipId = X AND is_current AND deleted_at IS NULL`).
   *   2. Validate it is `changes_requested` (the only state from which a resubmit
   *      is legal) — throw `InvalidProposalTransitionError` otherwise.
   *   3. FLIP it first: `is_current = false`, `status = 'resubmitted'` — this
   *      VACATES the partial-unique slot within the same transaction.
   *   4. THEN insert the new version: `version = old.version + 1`, `is_current =
   *      true`, `status = 'submitted'`, copying the denormalised
   *      relationship/request/expert ids from the locked row.
   *
   * Flip-then-insert, NEVER insert-then-flip (which would momentarily have two
   * `is_current=true` rows and trip the index). Child rows
   * (milestones/installments/documents) are NOT copied — the composer (A6.2)
   * carries the revised content; `resubmit` copies only the proposal header.
   * Returns the new current proposal.
   */
  async resubmit(input: {
    relationshipId: string;
    overview: string;
    pricingMethod: PricingMethod;
    priceCents: number;
    currency?: string;
    timeframeWeeks?: number;
    exclusions?: string;
    depositCents?: number;
    rateCents?: number;
    cadence?: ProposalCadence;
  }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.relationshipId, input.relationshipId),
            eq(proposals.isCurrent, true),
            isNull(proposals.deletedAt)
          )
        )
        .for('update');

      if (current === undefined) {
        throw new Error(`No current proposal for relationship: ${input.relationshipId}`);
      }
      if (!isAllowedProposalTransition(current.status, 'resubmitted')) {
        throw new InvalidProposalTransitionError(current.status, 'resubmitted');
      }

      // FLIP FIRST — vacate the partial-unique slot before the insert.
      await tx
        .update(proposals)
        .set({ isCurrent: false, status: 'resubmitted' })
        .where(eq(proposals.id, current.id));

      // THEN insert the new current version.
      const [row] = await tx
        .insert(proposals)
        .values({
          relationshipId: current.relationshipId,
          projectRequestId: current.projectRequestId,
          expertProfileId: current.expertProfileId,
          status: 'submitted',
          version: current.version + 1,
          isCurrent: true,
          overview: input.overview,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          currency: input.currency,
          timeframeWeeks: input.timeframeWeeks,
          exclusions: input.exclusions,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create resubmitted proposal');
      }
      return row;
    });
  },
};
