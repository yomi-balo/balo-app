'use server';
import 'server-only';

import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { withAuth } from '@/lib/auth/with-auth';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  deleteProjectDocumentFromR2,
  ALLOWED_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  PROJECT_DOCUMENT_PREFIX,
} from '@/lib/storage/project-document';
import { log } from '@/lib/logging';

// project-documents/{companyId uuid}/{userId uuid}/{uuid}
const PROJECT_DOCUMENT_KEY_PATTERN =
  /^project-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

export interface ConfirmProjectDocumentUploadInput {
  key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface ConfirmedProjectDocument {
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface ConfirmProjectDocumentUploadResult {
  success: boolean;
  document?: ConfirmedProjectDocument;
  error?: string;
}

/**
 * Server source of truth for an uploaded project document. Validates the key is
 * scoped to the session's company + user, HEAD-checks the R2 object's real size
 * and type, and returns a TRUSTED ref the client holds in its draft. Does NOT
 * write to the DB — the document row is created transactionally at submit.
 */
export const confirmProjectDocumentUploadAction = withAuth(
  async (
    session,
    input: ConfirmProjectDocumentUploadInput
  ): Promise<ConfirmProjectDocumentUploadResult> => {
    try {
      // 1. Validate key shape + scope (company/user from session, never client).
      if (!PROJECT_DOCUMENT_KEY_PATTERN.test(input.key)) {
        return { success: false, error: 'Invalid upload key.' };
      }
      const expectedPrefix = `${PROJECT_DOCUMENT_PREFIX}${session.user.companyId}/${session.user.id}/`;
      if (!input.key.startsWith(expectedPrefix)) {
        return { success: false, error: 'Invalid upload key.' };
      }

      // 2. Verify the object in R2 — size + type are re-checked from the source.
      const head = await r2Client.send(
        new HeadObjectCommand({ Bucket: R2_BUCKET, Key: input.key })
      );

      const contentLength = head.ContentLength;
      if (!contentLength || contentLength > MAX_DOCUMENT_BYTES) {
        deleteProjectDocumentFromR2(input.key).catch(() => {});
        return {
          success: false,
          error: 'Uploaded file is too large. Please try a smaller file.',
        };
      }

      // R2's stored content type is authoritative; fall back to the client claim.
      const resolvedContentType = head.ContentType ?? input.contentType;
      if (!ALLOWED_CONTENT_TYPES.has(resolvedContentType)) {
        deleteProjectDocumentFromR2(input.key).catch(() => {});
        return { success: false, error: 'This file type is not supported.' };
      }

      log.info('Project document upload confirmed', {
        userId: session.user.id,
        companyId: session.user.companyId,
        key: input.key,
        sizeBytes: contentLength,
      });

      return {
        success: true,
        document: {
          r2Key: input.key,
          fileName: input.fileName,
          contentType: resolvedContentType,
          sizeBytes: contentLength,
        },
      };
    } catch (error) {
      log.error('Failed to confirm project document upload', {
        userId: session.user.id,
        companyId: session.user.companyId,
        key: input.key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Failed to save document. Please try again.' };
    }
  }
);
