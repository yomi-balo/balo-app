import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposalChangeRequests, type ProposalChangeRequest } from '../schema';
import type { ProposalChangeSection } from './proposal-types';

export const proposalChangeRequestsRepository = {
  /**
   * Insert a change request against a specific proposal version. `proposalVersion`
   * is a SNAPSHOT int (the version the change was raised against), so the history
   * reads correctly after a later resubmit. `section` defaults to `general`.
   *
   * CONTRACT — bare INSERT. Raw FK violation (23503) on an unknown `proposalId`
   * (ON DELETE cascade) or `requestedByUserId` (ON DELETE restrict); CHECK (23514)
   * if `proposalVersion < 1`. The higher-level `requestChanges` flow on
   * `proposalsRepository` writes this row inside the same transaction that
   * advances the proposal status — this repo is the raw-create entry point.
   */
  async create(input: {
    proposalId: string;
    requestedByUserId: string;
    section?: ProposalChangeSection;
    note: string;
    proposalVersion: number;
  }): Promise<ProposalChangeRequest> {
    const [row] = await db
      .insert(proposalChangeRequests)
      .values({
        proposalId: input.proposalId,
        requestedByUserId: input.requestedByUserId,
        note: input.note,
        proposalVersion: input.proposalVersion,
        section: input.section,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create proposal change request');
    }
    return row;
  },

  /** Live change requests for a proposal, newest first. */
  async listByProposal(proposalId: string): Promise<ProposalChangeRequest[]> {
    return db
      .select()
      .from(proposalChangeRequests)
      .where(
        and(
          eq(proposalChangeRequests.proposalId, proposalId),
          isNull(proposalChangeRequests.deletedAt)
        )
      )
      .orderBy(desc(proposalChangeRequests.createdAt));
  },
};
