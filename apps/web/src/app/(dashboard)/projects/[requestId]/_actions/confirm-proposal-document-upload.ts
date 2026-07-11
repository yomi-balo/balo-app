'use server';

import 'server-only';

import { z } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { proposalsRepository, proposalDocumentsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES,
  PROPOSAL_DOCUMENT_PREFIX,
  MAX_PROPOSAL_DOCUMENT_BYTES,
  deleteProposalDocumentFromR2,
} from '@/lib/storage/proposal-document';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';

// proposal-documents/{proposalId uuid}/{userId uuid}/{uuid}
const PROPOSAL_DOCUMENT_KEY_PATTERN =
  /^proposal-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  proposalId: z.uuid(),
  kind: z.enum(['terms', 'ref']),
  key: z.string().min(1).max(512),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
});

export type ConfirmProposalDocumentUploadInput = z.infer<typeof inputSchema>;

/**
 * The view of a persisted proposal document — the canonical shape the composer
 * carries in state for display/removal. Created here; the remove/download actions
 * import this type.
 */
export interface ProposalDocumentView {
  id: string;
  proposalId: string;
  kind: 'terms' | 'ref';
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  createdAtIso: string;
}

export type ConfirmProposalDocumentUploadResult =
  | { success: true; document: ProposalDocumentView }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_EXPERT = 'Only the expert can attach proposal documents.';
const STALE_PROPOSAL = 'This proposal can no longer be edited.';
const INVALID_KEY = 'Invalid upload key.';
const GENERIC_FAILURE = 'Could not attach your document. Please try again.';

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505) — a double
 * confirm of the same R2 key trips `proposal_document_key_idx`. Structural
 * narrowing (no `any`, no assertion) — the `in` guard narrows `object` to carry
 * `code`.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '23505';
}

/** Key shape + provenance: proposal from VALIDATED ownership, user from session. */
function validateUploadKey(key: string, proposalId: string, userId: string): string | null {
  if (!PROPOSAL_DOCUMENT_KEY_PATTERN.test(key)) {
    return INVALID_KEY;
  }
  const expectedPrefix = `${PROPOSAL_DOCUMENT_PREFIX}${proposalId}/${userId}/`;
  if (!key.startsWith(expectedPrefix)) {
    return INVALID_KEY;
  }
  return null;
}

type UploadedObjectCheck =
  | { ok: true; sizeBytes: number; contentType: string }
  | { ok: false; error: string };

/**
 * HEAD-checks the object in R2 — size + type re-checked at the source. A rejected
 * object is best-effort deleted. Missing/zero size and over-cap are DIFFERENT
 * failures with distinct copy.
 */
async function verifyUploadedObject(
  key: string,
  claimedContentType: string
): Promise<UploadedObjectCheck> {
  const head = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));

  const realSize = head.ContentLength;
  if (realSize === undefined || realSize === 0) {
    deleteProposalDocumentFromR2(key).catch(() => {});
    return { ok: false, error: 'The uploaded file appears to be empty.' };
  }
  if (realSize > MAX_PROPOSAL_DOCUMENT_BYTES) {
    deleteProposalDocumentFromR2(key).catch(() => {});
    return { ok: false, error: 'Uploaded file is too large. Please try a smaller file.' };
  }

  const resolvedContentType = head.ContentType ?? claimedContentType;
  if (!PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES.has(resolvedContentType)) {
    deleteProposalDocumentFromR2(key).catch(() => {});
    return { ok: false, error: 'This file type is not supported.' };
  }

  return { ok: true, sizeBytes: realSize, contentType: resolvedContentType };
}

/**
 * Loads the proposal and verifies it belongs to this relationship and is still an
 * editable `draft`. Returns `true` when editable; `false` (→ stale copy) otherwise.
 */
async function isEditableDraft(proposalId: string, relationshipId: string): Promise<boolean> {
  const proposal = await proposalsRepository.findById(proposalId);
  return (
    proposal !== undefined &&
    proposal.relationshipId === relationshipId &&
    proposal.status === 'draft'
  );
}

/**
 * Replace-semantics for the single `terms` supplement: soft-delete every prior
 * live `terms` doc and best-effort R2-delete its object (one supplement max). A
 * no-op for `ref` docs. Extracted to keep the action's cognitive complexity low.
 */
async function replacePriorTermsSupplement(context: {
  proposalId: string;
  requestId: string;
  relationshipId: string;
  userId: string;
}): Promise<void> {
  const { proposalId, requestId, relationshipId, userId } = context;
  const priorTerms = await proposalDocumentsRepository.listByProposal(proposalId, 'terms');
  for (const prior of priorTerms) {
    const removed = await proposalDocumentsRepository.softDelete(prior.id);
    if (removed === undefined) continue;
    deleteProposalDocumentFromR2(prior.r2Key).catch(() => {});
    log.warn('Replaced prior terms supplement on a proposal', {
      requestId,
      relationshipId,
      proposalId,
      userId,
      replacedDocumentId: prior.id,
    });
  }
}

/**
 * Confirm an uploaded proposal document (A6.2 / BAL-288, step 3): validates key
 * shape + provenance (proposal from VALIDATED ownership, user from session),
 * HEAD-checks the real size/type in R2, then inserts the `proposal_documents`
 * row. The TERMS supplement is single — before confirming a new `terms` doc, any
 * existing live `terms` doc is soft-deleted and best-effort R2-deleted (replace
 * semantics, one supplement max).
 *
 * `addDocument` is called STANDALONE (no wider transaction) so its bare-insert
 * contract is satisfied; a duplicate r2Key (23505) maps to friendly copy.
 */
export async function confirmProposalDocumentUploadAction(
  input: ConfirmProposalDocumentUploadInput
): Promise<ConfirmProposalDocumentUploadResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId, proposalId, kind, key, fileName, contentType } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: ONLY_EXPERT };
    }

    // The proposal must belong to this relationship and still be an editable draft.
    if (!(await isEditableDraft(proposalId, relationshipId))) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // 1. Key shape + provenance.
    const keyError = validateUploadKey(key, proposalId, user.id);
    if (keyError !== null) {
      return { success: false, error: keyError };
    }

    // 2. Verify the object in R2.
    const verified = await verifyUploadedObject(key, contentType);
    if (!verified.ok) {
      return { success: false, error: verified.error };
    }

    // 3. Terms supplement is single — replace any prior live `terms` doc first.
    if (kind === 'terms') {
      await replacePriorTermsSupplement({
        proposalId,
        requestId,
        relationshipId,
        userId: user.id,
      });
    }

    // 4. Insert the row (standalone — isolate dup r2Key 23505 below).
    const row = await proposalDocumentsRepository.addDocument({
      proposalId,
      uploadedByUserId: user.id,
      kind,
      r2Key: key,
      fileName,
      contentType: verified.contentType,
      sizeBytes: verified.sizeBytes,
    });

    const document: ProposalDocumentView = {
      id: row.id,
      proposalId,
      kind: row.kind,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedByUserId: user.id,
      createdAtIso: row.createdAt.toISOString(),
    };

    log.info('Proposal document attached', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      documentId: row.id,
      kind,
    });

    return { success: true, document };
  } catch (error) {
    // A duplicate confirm (double-click/retry) is EXPECTED — warn, not error.
    if (isUniqueViolation(error)) {
      log.warn('Duplicate proposal document confirm (expected double-click)', {
        requestId,
        relationshipId,
        proposalId,
        userId: user.id,
        key,
      });
      return { success: false, error: 'This document was already attached.' };
    }
    log.error('Failed to confirm proposal document upload', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      key,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
