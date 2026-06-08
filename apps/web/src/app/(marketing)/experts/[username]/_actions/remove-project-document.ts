'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteProjectDocumentFromR2,
  PROJECT_DOCUMENT_PREFIX,
} from '@/lib/storage/project-document';
import { log } from '@/lib/logging';

export interface RemoveProjectDocumentInput {
  key: string;
}

export interface RemoveProjectDocumentResult {
  success: boolean;
  error?: string;
}

/**
 * Best-effort removal of a not-yet-persisted project document from R2 (the draft
 * holds the ref until submit). Validates the key is scoped to the session's
 * company + user before deleting. No DB delete — the row does not exist yet.
 */
export const removeProjectDocumentAction = withAuth(
  async (session, input: RemoveProjectDocumentInput): Promise<RemoveProjectDocumentResult> => {
    try {
      const expectedPrefix = `${PROJECT_DOCUMENT_PREFIX}${session.user.companyId}/${session.user.id}/`;
      if (!input.key.startsWith(expectedPrefix)) {
        return { success: false, error: 'Invalid upload key.' };
      }

      await deleteProjectDocumentFromR2(input.key);

      log.info('Project document removed', {
        userId: session.user.id,
        companyId: session.user.companyId,
        key: input.key,
      });

      return { success: true };
    } catch (error) {
      log.error('Failed to remove project document', {
        userId: session.user.id,
        companyId: session.user.companyId,
        key: input.key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Failed to remove document. Please try again.' };
    }
  }
);
