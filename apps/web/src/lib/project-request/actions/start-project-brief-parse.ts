'use server';
import 'server-only';

import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { projectBriefParsesRepository } from '@balo/db';
import {
  isSessionOwnedProjectDocumentKey,
  MAX_PARSE_INPUT_BYTES,
  MAX_PARSES_PER_HOUR,
} from '@balo/shared/project-requests';
import { postBaloApiJson } from '@/lib/api/balo-api-client';
import { log } from '@/lib/logging';
import { documentRefSchema, MAX_DOCUMENTS } from './schemas';

const ONE_HOUR_MS = 60 * 60 * 1000;

const startProjectBriefParseInputSchema = z.object({
  documents: z.array(documentRefSchema).min(1).max(MAX_DOCUMENTS),
});

export interface StartProjectBriefParseResult {
  success: boolean;
  parseId?: string;
  error?: string;
}

/** The api answers `{ enqueued: true }` on success — nothing else is read from the body. */
function parseEnqueueResponse(parsed: Record<string, unknown>): { enqueued: true } | null {
  return parsed['enqueued'] === true ? { enqueued: true } : null;
}

const GENERIC_ERROR = 'Something went wrong generating your brief. Your files are still attached.';

/**
 * BAL-254 — validate the uploaded documents, write the `project_brief_parses` row, and ask
 * `apps/api` to enqueue the parse job. ⚠⚠ RULING A — every `r2Key` is re-derived against the
 * SESSION here, via {@link isSessionOwnedProjectDocumentKey} — the ONE definition, shared with
 * `confirmProjectDocumentUploadAction`. The job payload the api enqueues is `{ parseId }` alone;
 * no key ever crosses the wire (D1).
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

    const since = new Date(Date.now() - ONE_HOUR_MS);
    const recentCount = await projectBriefParsesRepository.countCreatedSince({
      requestedByUserId: session.user.id,
      since,
    });
    if (recentCount >= MAX_PARSES_PER_HOUR) {
      return {
        success: false,
        error:
          "You've generated a lot of briefs in the last hour — give it a few minutes and try again.",
      };
    }

    const row = await projectBriefParsesRepository.create({
      companyId: session.user.companyId,
      requestedByUserId: session.user.id,
      sourceDocuments: documents.map((doc) => ({
        r2Key: doc.r2Key,
        fileName: doc.fileName,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
      })),
    });

    const result = await postBaloApiJson(
      '/project-briefs/parse',
      { parseId: row.id },
      parseEnqueueResponse,
      'project brief parse'
    );

    if (!result.ok) {
      await projectBriefParsesRepository.markFailed({
        parseId: row.id,
        failureReason: 'enqueue_failed',
      });
      log.error('Project brief parse enqueue failed', {
        userId: session.user.id,
        companyId: session.user.companyId,
        parseId: row.id,
        status: result.status,
        code: result.code,
      });
      return { success: false, error: GENERIC_ERROR };
    }

    log.info('Project brief parse started', {
      userId: session.user.id,
      companyId: session.user.companyId,
      parseId: row.id,
      documentCount: documents.length,
    });

    return { success: true, parseId: row.id };
  }
);
