import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  proposals,
  proposalChangeRequests,
  projectRequests,
  requestExpertRelationships,
  type Proposal,
  type ProposalChangeRequest,
} from '../schema';
import { advanceRelationshipStatus } from './request-expert-relationships';
import {
  insertMilestonesTx,
  listByProposalTx as listMilestonesTx,
  type ProposalMilestoneInput,
} from './proposal-milestones';
import {
  insertInstallmentsTx,
  listByProposalTx as listInstallmentsTx,
  type ProposalPaymentInstallmentInput,
} from './proposal-payment-installments';
import { assertProposalCoherent, type ProposalCoherenceSnapshot } from './proposal-coherence';
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
 * Thrown by `updateDraft` when the targeted proposal is not a live `draft`
 * (missing, soft-deleted, or already `submitted`/beyond). Guards a stale autosave
 * from silently overwriting a submitted proposal — the action surfaces it as
 * "This proposal can no longer be edited." Modelled on the repo's existing
 * `InvalidProposalTransitionError` (a typed, named domain error the action
 * `instanceof`-checks), not a bare `Error`.
 */
export class ProposalNotDraftError extends Error {
  constructor(public readonly status: ProposalStatus | null) {
    super(
      status === null
        ? 'Proposal not found or soft-deleted: cannot update a draft.'
        : `Proposal is not a draft (status: ${status}): cannot update.`
    );
    this.name = 'ProposalNotDraftError';
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

/**
 * Assemble a `ProposalCoherenceSnapshot` from a proposal header + its milestone /
 * installment children for the transition-time coherence guard. Shared by every
 * committing path (`submit`, `promoteToSubmit`, `accept`, `resubmit`) so the
 * assembly lives in exactly one place (avoids Sonar duplication). The header param
 * is a minimal structural shape both a DB-row `Proposal` and the caller-input
 * headers satisfy.
 */
function toCoherenceSnapshot(
  header: {
    pricingMethod: PricingMethod;
    priceCents: number;
    currency: string | null;
    depositCents: number | null;
    rateCents: number | null;
    cadence: ProposalCadence | null;
  },
  milestones: { valueCents?: number | null; estimatedMinutes?: number | null }[],
  installments: { pct: number }[]
): ProposalCoherenceSnapshot {
  return {
    pricingMethod: header.pricingMethod,
    priceCents: header.priceCents,
    currency: header.currency ?? 'aud',
    depositCents: header.depositCents,
    rateCents: header.rateCents,
    cadence: header.cadence,
    // Live milestones only — both read paths (`listMilestonesTx`,
    // `setForProposal`) already filter `deletedAt`; soft-deleted rows must never
    // reach the snapshot (BAL-294 effort clauses run over the snapshot as-is).
    milestones: milestones.map((m) => ({
      valueCents: m.valueCents ?? null,
      estimatedMinutes: m.estimatedMinutes ?? null,
    })),
    installments: installments.map((i) => ({ pct: i.pct })),
  };
}

/**
 * Read the request-level Balo fee (basis points) inside the active transaction.
 * The fee is snapshotted onto each proposal version at create/resubmit — it is
 * system-sourced from the request, NEVER trusted from the caller (same rule as
 * the denormalised projectRequestId/expertProfileId). Shared by `submit`,
 * `createDraft`, and `resubmit` so the read lives in exactly one place.
 */
async function readRequestBaloFeeBpsTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectRequestId: string
): Promise<number> {
  const [request] = await tx
    .select({ baloFeeBps: projectRequests.baloFeeBps })
    .from(projectRequests)
    .where(eq(projectRequests.id, projectRequestId));
  if (request === undefined) {
    throw new Error(`Project request not found: ${projectRequestId}`);
  }
  return request.baloFeeBps;
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
   * BOUNDARY (ADR-1025 / BAL-295): advancing the relationship to
   * `proposal_submitted` ALSO advances the request-level status via
   * `deriveRequestStatus` inside `advanceRelationshipStatus`, in the SAME
   * transaction — no longer caller-owned. Draft persistence (insert as `draft`) is
   * A6.2; this inserts directly as `submitted`.
   *
   * COHERENCE (BAL-293): asserts `assertProposalCoherent` at the TOP of the tx,
   * built from the supplied header with EMPTY milestones/installments (this legacy
   * path carries no children). CONSEQUENCE: a `fixed` `submit()` trips
   * `fixed_requires_installments` — correct by design. The active fixed path is
   * draft→`promoteToSubmit` (which re-reads the persisted children); this legacy
   * insert-as-submitted has no production callers and is the `tm` / test path.
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
      // Coherence guard — supplied header, no children (legacy header-only insert).
      assertProposalCoherent(
        toCoherenceSnapshot(
          {
            pricingMethod: input.pricingMethod,
            priceCents: input.priceCents,
            currency: input.currency ?? null,
            depositCents: input.depositCents ?? null,
            rateCents: input.rateCents ?? null,
            cadence: input.cadence ?? null,
          },
          [],
          []
        )
      );

      const relationship = await advanceRelationshipStatus(tx, {
        id: input.relationshipId,
        to: 'proposal_submitted',
        expectedFrom: 'proposal_requested',
      });

      // Snapshot the Balo fee from the request (system-sourced, never caller-trusted).
      const baloFeeBps = await readRequestBaloFeeBpsTx(tx, relationship.projectRequestId);

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
          baloFeeBps,
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

  /**
   * Create the relationship's FIRST `draft` proposal (status `draft`, `version` 1,
   * `is_current` true) — the draft-persistence counterpart `submit()` deferred in
   * A6.1. Mirrors `submit()`'s id derivation: denormalised request/expert ids are
   * read FROM the (locked) relationship row, never trusted from the caller. Unlike
   * `submit()`, this does NOT advance the relationship — drafts are private and the
   * spine only moves on actual submit (`promoteToSubmit`).
   *
   * The partial unique `proposal_current_per_relationship_idx` permits exactly one
   * live `is_current` row per relationship, so this throws a 23505 if a current
   * proposal already exists — the action MUST call `findCurrentByRelationship`
   * first and route to `updateDraft` instead. `priceCents` is integer minor units
   * and may be 0 for a partial draft; `overview` may be near-empty HTML.
   *
   * Locks the relationship FOR UPDATE (`advanceRelationshipStatus` is not used —
   * we don't transition — so the lock is taken directly) to read a consistent id
   * triple, matching the spirit of `submit()` reading from a locked row.
   */
  async createDraft(input: {
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
      const [relationship] = await tx
        .select()
        .from(requestExpertRelationships)
        .where(
          and(
            eq(requestExpertRelationships.id, input.relationshipId),
            isNull(requestExpertRelationships.deletedAt)
          )
        )
        .for('update');

      if (relationship === undefined) {
        throw new Error(`Request expert relationship not found: ${input.relationshipId}`);
      }

      // Snapshot the Balo fee from the request (system-sourced, never caller-trusted).
      const baloFeeBps = await readRequestBaloFeeBpsTx(tx, relationship.projectRequestId);

      const [row] = await tx
        .insert(proposals)
        .values({
          relationshipId: relationship.id,
          projectRequestId: relationship.projectRequestId,
          expertProfileId: relationship.expertProfileId,
          status: 'draft',
          version: 1,
          isCurrent: true,
          overview: input.overview,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          currency: input.currency,
          baloFeeBps,
          timeframeWeeks: input.timeframeWeeks,
          exclusions: input.exclusions,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create draft proposal');
      }
      return row;
    });
  },

  /**
   * Update the header fields of an EXISTING current draft (the composer's debounced
   * autosave). Locks the row FOR UPDATE and guards `status === 'draft'` so a stale
   * autosave landing AFTER a submit can never silently overwrite the submitted
   * proposal — throws `ProposalNotDraftError` (missing/soft-deleted/non-draft). On
   * success touches `updatedAt`.
   *
   * BOUNDARY: writes ONLY the proposal header. Milestones / installments /
   * documents are persisted via their own `setForProposal` / document repos by the
   * action, NOT here — keeping autosave a single-row write.
   */
  async updateDraft(input: {
    proposalId: string;
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
        .where(and(eq(proposals.id, input.proposalId), isNull(proposals.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new ProposalNotDraftError(null);
      }
      if (current.status !== 'draft') {
        throw new ProposalNotDraftError(current.status);
      }

      const [updated] = await tx
        .update(proposals)
        .set({
          overview: input.overview,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          currency: input.currency,
          timeframeWeeks: input.timeframeWeeks,
          exclusions: input.exclusions,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to update draft proposal: ${input.proposalId}`);
      }
      return updated;
    });
  },

  /**
   * Promote an existing `draft` proposal to `submitted` AND advance the
   * relationship `proposal_requested → proposal_submitted`, in ONE transaction —
   * the draft-first counterpart to `submit()`'s insert-as-submitted. The header /
   * milestones / installments are already persisted by the action's preceding
   * sanitise → `updateDraft` / `setForProposal` steps; promotion ONLY flips status
   * and advances the spine. Takes only ids.
   *
   * STRICT order inside the tx (matches `submit()`: relationship spine first):
   *   1. `advanceRelationshipStatus(tx, { id: relationshipId, to:'proposal_submitted',
   *      expectedFrom:'proposal_requested' })` — locks + validates the spine.
   *   2. update the proposal: status `draft → submitted` guarded via the shared
   *      `advanceProposalStatus(tx, { id, to:'submitted', expectedFrom:'draft' })`,
   *      then re-stamp `submittedAt = now()` in a LOCAL update.
   *
   * The proposal is already `is_current = true` (created as a draft), so NO
   * `is_current` flip is needed and the one-current slot never collides. Throws
   * `InvalidRelationshipTransitionError` / `InvalidProposalTransitionError` (and
   * the whole tx rolls back) if either is not in its expected state — so a
   * double-submit / stale tab is rejected, not double-applied.
   *
   * BOUNDARY (ADR-1025 / BAL-295): the step-1 relationship advance to
   * `proposal_submitted` ALSO advances the request-level status via
   * `deriveRequestStatus` inside `advanceRelationshipStatus`, in this SAME
   * transaction — the request rollup is no longer caller-owned.
   *
   * `submittedAt` re-stamp: `proposals.submittedAt` defaults to `now()` at INSERT
   * (draft creation), so a draft carries a creation-time `submittedAt`. We re-stamp
   * it LOCALLY here (the actual submit instant) rather than changing the shared
   * `advanceProposalStatus`, which `accept`/`resubmit` also route through.
   */
  async promoteToSubmit(input: { proposalId: string; relationshipId: string }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      // 1. Advance the relationship spine first (locks + validates).
      await advanceRelationshipStatus(tx, {
        id: input.relationshipId,
        to: 'proposal_submitted',
        expectedFrom: 'proposal_requested',
      });

      // 1b. COHERENCE (BAL-293): lock + re-read the live header + children INSIDE
      // the tx (the header/milestones/installments were written by the action's
      // preceding updateDraft/setForProposal steps) and assert coherence BEFORE the
      // flip. Throw → whole tx rolls back: proposal stays `draft`, relationship
      // reverts. The header is taken `FOR UPDATE` (mirroring accept()) so the
      // coherence snapshot is provably the row that advanceProposalStatus then flips
      // — no plain-read TOCTOU window before the lock. (Lock order is unchanged: the
      // relationship is already locked above, and advanceProposalStatus re-locks this
      // same row, so no new deadlock hazard.)
      const [header] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, input.proposalId), isNull(proposals.deletedAt)))
        .for('update');
      if (header === undefined) {
        throw new Error(`Proposal not found: ${input.proposalId}`);
      }
      const milestones = await listMilestonesTx(tx, input.proposalId);
      const installments = await listInstallmentsTx(tx, input.proposalId);
      assertProposalCoherent(toCoherenceSnapshot(header, milestones, installments));

      // 2. Flip the proposal status through the guarded writer (draft → submitted).
      const advanced = await advanceProposalStatus(tx, {
        id: input.proposalId,
        to: 'submitted',
        expectedFrom: 'draft',
      });

      // Re-stamp submittedAt to the actual submit instant (local update — never
      // mutate the shared advanceProposalStatus, which accept/resubmit reuse).
      const [stamped] = await tx
        .update(proposals)
        .set({ submittedAt: new Date() })
        .where(eq(proposals.id, advanced.id))
        .returning();
      if (stamped === undefined) {
        throw new Error(`Failed to stamp submittedAt on proposal: ${input.proposalId}`);
      }
      return stamped;
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
   * BOUNDARY (ADR-1025 / BAL-295): advancing the relationship to `accepted` ALSO
   * advances the request-level status via `deriveRequestStatus` inside
   * `advanceRelationshipStatus`, in this SAME transaction — the request rollup is
   * no longer caller-owned. Still creates NO delivery/engagement record (A6.5 owns
   * that).
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

      // COHERENCE (BAL-293): re-read the live children under the proposal's
      // FOR UPDATE lock and assert coherence BEFORE advancing either spine. Throw →
      // tx rolls back: proposal stays `submitted`, relationship `proposal_submitted`.
      const milestones = await listMilestonesTx(tx, current.id);
      const installments = await listInstallmentsTx(tx, current.id);
      assertProposalCoherent(toCoherenceSnapshot(current, milestones, installments));

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
   * `is_current=true` rows and trip the index). The v2 milestones + installments are
   * written in the SAME transaction from the caller-supplied set (via
   * `insertMilestonesTx`/`insertInstallmentsTx`), so a `submitted`/`is_current` v2
   * NEVER exists with zero children — header + children commit atomically (a child
   * write failure rolls back the whole resubmit). The composer (A6.2) carries the
   * revised content; documents are still carried over best-effort by the action AFTER
   * the commit. Returns the new current proposal.
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
    milestones: ProposalMilestoneInput[];
    installments: ProposalPaymentInstallmentInput[];
  }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      // COHERENCE (BAL-293): the caller supplies the full v2 header + children, so
      // assert at the TOP of the tx, BEFORE the flip-then-insert. Throw → tx rolls
      // back: v1 keeps `is_current`/`changes_requested`, no v2 row, no child writes.
      assertProposalCoherent(
        toCoherenceSnapshot(
          {
            pricingMethod: input.pricingMethod,
            priceCents: input.priceCents,
            currency: input.currency ?? null,
            depositCents: input.depositCents ?? null,
            rateCents: input.rateCents ?? null,
            cadence: input.cadence ?? null,
          },
          input.milestones,
          input.installments
        )
      );

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

      // Snapshot the Balo fee from the REQUEST's CURRENT value (NOT the prior
      // proposal) — a fee change since v1 applies to the new version. Read via the
      // locked row's projectRequestId.
      const baloFeeBps = await readRequestBaloFeeBpsTx(tx, current.projectRequestId);

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
          baloFeeBps,
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

      // Write v2's children INSIDE this transaction so a current/submitted v2 can
      // never exist without its milestones + installments (atomic with the header).
      await insertMilestonesTx(tx, row.id, input.milestones);
      await insertInstallmentsTx(tx, row.id, input.installments);

      return row;
    });
  },
};
