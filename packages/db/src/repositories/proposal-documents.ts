import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposalDocuments, type ProposalDocument } from '../schema';
import type { ProposalDocumentKind } from './proposal-types';

export const proposalDocumentsRepository = {
  /**
   * Attach a document to a proposal (the 3rd file scope). Unique `r2_key`
   * enforced (`proposal_document_key_idx`).
   *
   * CONTRACT — bare INSERT, no error isolation (mirrors
   * `conversationsRepository.addFile`). A single un-wrapped `db.insert(...)` that
   * can throw a raw constraint violation: unique (23505) on a duplicate `r2Key`,
   * or FK (23503) on an unknown `proposalId` (ON DELETE cascade) /
   * `uploadedByUserId` (ON DELETE restrict). If called INSIDE an open
   * `db.transaction(...)`, that error ABORTS the transaction (25P02) — every later
   * statement fails until rollback. The A6.2 caller MUST isolate this insert —
   * its own SAVEPOINT (nested `tx.transaction(...)`), or pre-empt the duplicate
   * with `.onConflictDoNothing({ target: proposalDocuments.r2Key })` — so a
   * duplicate upload can't poison a wider transaction. No production callers yet.
   */
  async addDocument(input: {
    proposalId: string;
    uploadedByUserId: string;
    kind: ProposalDocumentKind;
    r2Key: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<ProposalDocument> {
    const [row] = await db
      .insert(proposalDocuments)
      .values({
        proposalId: input.proposalId,
        uploadedByUserId: input.uploadedByUserId,
        kind: input.kind,
        r2Key: input.r2Key,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create proposal document');
    }
    return row;
  },

  /** Live documents for a proposal, oldest first, optionally filtered by `kind`. */
  async listByProposal(
    proposalId: string,
    kind?: ProposalDocumentKind
  ): Promise<ProposalDocument[]> {
    return db
      .select()
      .from(proposalDocuments)
      .where(
        and(
          eq(proposalDocuments.proposalId, proposalId),
          isNull(proposalDocuments.deletedAt),
          kind === undefined ? undefined : eq(proposalDocuments.kind, kind)
        )
      )
      .orderBy(asc(proposalDocuments.createdAt));
  },

  /**
   * Soft-delete a live document (composer "remove attachment"). Filters
   * `deletedAt IS NULL` so it is idempotent — re-removing an already-removed row
   * is a no-op that returns `undefined`. The removed row then disappears from
   * `listByProposal`.
   */
  async softDelete(id: string): Promise<ProposalDocument | undefined> {
    const [updated] = await db
      .update(proposalDocuments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(proposalDocuments.id, id), isNull(proposalDocuments.deletedAt)))
      .returning();
    return updated;
  },
};
