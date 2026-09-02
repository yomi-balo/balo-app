'use server';

import 'server-only';

import { z } from 'zod';
import {
  requestSharedFilesRepository,
  RequestFileGrantNotFoundError,
  RequestFileNotFoundError,
} from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, REQUEST_FILE_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  authorizeRequestFileScope,
  REQUEST_FILES_UNAVAILABLE_COPY,
} from '@/lib/request-files/authorize-request-file-scope';

const inputSchema = z.object({
  requestId: z.uuid(),
  fileId: z.uuid(),
  relationshipId: z.uuid(),
});

export type RevokeRequestFileGrantResult = { success: true } | { success: false; error: string };

/**
 * Revoke ONE explicit grant (BAL-431 / ADR-1048 §4) — `side === 'client'` only (Ruling 3: the
 * SAME participation predicate that grants upload also grants delete/revoke). SILENT BY
 * DECISION: no notification is published anywhere; a toast is client-side UI feedback and is
 * not the notification engine.
 */
export async function revokeRequestFileGrantAction(
  input: z.infer<typeof inputSchema>
): Promise<RevokeRequestFileGrantResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, fileId, relationshipId } = parsed.data;

  try {
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok) {
      return { success: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
    }
    if (scope.side !== 'client') {
      return { success: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
    }

    await requestSharedFilesRepository.revokeGrant({
      fileId,
      projectRequestId: scope.request.id,
      relationshipId,
      actorUserId: user.id,
    });

    trackServerAndFlush(REQUEST_FILE_SERVER_EVENTS.AUDIENCE_CHANGED, {
      action: 'revoke',
      audience_type: 'grants',
      distinct_id: user.id,
    });

    log.info('Request file grant revoked', {
      requestId: scope.request.id,
      fileId,
      relationshipId,
      userId: user.id,
    });

    return { success: true };
  } catch (error) {
    if (
      error instanceof RequestFileNotFoundError ||
      error instanceof RequestFileGrantNotFoundError
    ) {
      return { success: false, error: 'This file is no longer available.' };
    }
    log.error('Failed to revoke request file grant', {
      requestId,
      fileId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not remove access. Please try again.' };
  }
}
