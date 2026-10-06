'use server';
import 'server-only';

import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import {
  isSessionOwnedProjectDocumentKey,
  MAX_PARSE_INPUT_BYTES,
} from '@balo/shared/project-requests';
import { log } from '@/lib/logging';
import { documentRefSchema, MAX_DOCUMENTS } from './schemas';
import {
  enqueueProjectBriefParse,
  type StartProjectBriefParseResult,
} from './enqueue-project-brief-parse';

// ⚠ Re-export WITH a `from` clause. A bare `export type { X };` in a `'use server'` file is
// compiled by Next into `registerServerReference(X, …)` against a binding that type erasure
// removed — a ReferenceError at module load that takes down EVERY action on the page.
export type { StartProjectBriefParseResult } from './enqueue-project-brief-parse';

const startProjectBriefParseInputSchema = z.object({
  documents: z.array(documentRefSchema).min(1).max(MAX_DOCUMENTS),
});

/**
 * BAL-254 — validate the uploaded documents, write the `project_brief_parses` row, and ask
 * `apps/api` to enqueue the parse job. ⚠⚠ RULING A — every `r2Key` is re-derived against the
 * SESSION here, via {@link isSessionOwnedProjectDocumentKey} — the ONE definition, shared with
 * `confirmProjectDocumentUploadAction`. The job payload the api enqueues is `{ parseId }` alone;
 * no key ever crosses the wire (D1).
 *
 * The rate limit, the row write, the api hop and the logs are {@link enqueueProjectBriefParse}'s
 * (BAL-589) — shared with the case-sourced start action — this action keeps only what is
 * specific to a DOCUMENTS source: the zod shape, the key check and the byte cap.
 */
export const startProjectBriefParseAction = withAuth(
  async (session, rawInput: unknown): Promise<StartProjectBriefParseResult> => {
    const parsed = startProjectBriefParseInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { success: false, error: 'Add at least one file to generate a brief.' };
    }
    const { documents } = parsed.data;

    // ⚠⚠ RULING A — treat the list as untrusted client input even though the uploader
    // produced it. Never log the key itself.
    const ownerScope = { companyId: session.user.companyId, userId: session.user.id };
    const hasForeignKey = documents.some(
      (doc) => !isSessionOwnedProjectDocumentKey(doc.r2Key, ownerScope)
    );
    if (hasForeignKey) {
      log.warn('Project brief parse rejected — document key outside session scope', {
        userId: session.user.id,
        companyId: session.user.companyId,
        documentCount: documents.length,
      });
      return { success: false, error: 'Invalid upload key.' };
    }

    const totalBytes = documents.reduce((sum, doc) => sum + doc.sizeBytes, 0);
    if (totalBytes > MAX_PARSE_INPUT_BYTES) {
      return {
        success: false,
        error: 'These files are a bit much to read in one go. Try fewer or smaller documents.',
      };
    }

    return enqueueProjectBriefParse({
      companyId: session.user.companyId,
      userId: session.user.id,
      source: {
        source: 'documents',
        sourceDocuments: documents.map((doc) => ({
          r2Key: doc.r2Key,
          fileName: doc.fileName,
          contentType: doc.contentType,
          sizeBytes: doc.sizeBytes,
        })),
      },
      logContext: { documentCount: documents.length },
    });
  }
);
