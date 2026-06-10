'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  expressionsOfInterestRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { log } from '@/lib/logging';

const inputSchema = z.object({ requestId: z.uuid() });

export type WithdrawEoiResult =
  | { success: true; relationshipId: string; expertProfileId: string }
  | { success: false; error: string };

type Relationship = ProjectRequestWithRelations['relationships'][number];

/**
 * Expert EOI withdrawal (BAL-270 / A3).
 *
 * IDOR-safe by construction: input is `{ requestId }` ONLY — the `relationshipId`
 * is derived server-side via `resolveRequestLens` (never client-supplied).
 *
 * Soft-deletes the live EOI ONLY (plan §4): NO relationship/request status revert
 * (the expert keeps participant access and may resubmit) and NO client
 * notification (withdraw is a quiet, reversible act). Idempotent — a stale/double
 * withdraw with no live EOI returns a friendly error rather than crashing.
 */
export async function withdrawEoiAction(
  input: z.infer<typeof inputSchema>
): Promise<WithdrawEoiResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: 'This request no longer exists.' };
    }

    const ctx = resolveRequestLens(user, request);
    if (ctx === null || ctx.lens !== 'expert' || ctx.relationshipId === null) {
      return { success: false, error: 'You are not an invited expert on this request.' };
    }
    const relationshipId = ctx.relationshipId; // server-derived, never client-supplied

    const rel: Relationship | undefined = request.relationships.find(
      (r) => r.id === relationshipId
    );
    if (rel === undefined) {
      return { success: false, error: 'You are not an invited expert on this request.' };
    }

    const removed = await expressionsOfInterestRepository.withdraw({ relationshipId });
    if (removed === undefined) {
      return { success: false, error: 'You have no active EOI to withdraw.' };
    }

    log.info('EOI withdrawn', { requestId, relationshipId, userId: user.id });

    revalidatePath(`/projects/${requestId}`);

    return { success: true, relationshipId, expertProfileId: rel.expertProfileId };
  } catch (error) {
    log.error('Failed to withdraw EOI', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not withdraw your interest. Please try again.' };
  }
}
