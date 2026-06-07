'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { createPresignedProjectDocumentUpload } from '@/lib/storage/project-document';
import { log } from '@/lib/logging';

export interface RequestProjectDocumentUploadInput {
  contentType: string;
  fileName: string;
}

export interface RequestProjectDocumentUploadResult {
  success: boolean;
  presignedUrl?: string;
  key?: string;
  error?: string;
}

/**
 * Presign a PUT for a single project document. Keys are scoped to the session's
 * company + user (never client-supplied). The client PUTs directly with XHR for
 * per-file progress, then calls the confirm action.
 */
export const requestProjectDocumentUploadAction = withAuth(
  async (
    session,
    input: RequestProjectDocumentUploadInput
  ): Promise<RequestProjectDocumentUploadResult> => {
    try {
      const { presignedUrl, key } = await createPresignedProjectDocumentUpload(
        session.user.companyId,
        session.user.id,
        input.contentType
      );
      return { success: true, presignedUrl, key };
    } catch (error) {
      log.error('Failed to create presigned project document upload URL', {
        userId: session.user.id,
        companyId: session.user.companyId,
        contentType: input.contentType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Failed to prepare upload. Please try again.' };
    }
  }
);
