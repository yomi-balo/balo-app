'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, InvalidStatusTransitionError } from '@balo/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({ requestId: z.uuid() });

export type RequestExploratoryMeetingResult =
  | {
      success: true;
      from: 'requested';
      to: 'exploratory_meeting_requested';
      /** ms from request creation → this (first) admin action — analytics. */
      firstAdminActionMs: number;
    }
  | { success: false; error: string };

/**
 * Admin triage — request an exploratory call (`requested → exploratory_meeting_requested`).
 *
 * The transition is the real, authoritative state change; the client's "Book
 * exploratory call" CTA (see `book-exploratory.ts`) is a downstream confirmation
 * stub and does NOT drive this. `expectedFrom: 'requested'` is the
 * optimistic-concurrency guard against two admins racing.
 */
export async function requestExploratoryMeetingAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestExploratoryMeetingResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { success: false, error: 'You do not have permission to do this.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  try {
    const updated = await projectRequestsRepository.transitionStatus({
      id: requestId,
      to: 'exploratory_meeting_requested',
      expectedFrom: 'requested',
    });

    log.info('Exploratory meeting requested', { requestId, adminUserId: admin.id });

    // Fire-and-forget — notification failure must not block the admin action.
    publishNotificationEvent('project.exploratory_requested', {
      correlationId: requestId,
      recipientId: updated.createdByUserId,
      projectRequestId: requestId,
      title: updated.title,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      from: 'requested',
      to: 'exploratory_meeting_requested',
      firstAdminActionMs: Date.now() - updated.createdAt.getTime(),
    };
  } catch (error) {
    log.error('Failed to request exploratory meeting', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (error instanceof InvalidStatusTransitionError) {
      return { success: false, error: 'This request can no longer move to an exploratory call.' };
    }
    return { success: false, error: 'Could not request an exploratory call. Please try again.' };
  }
}
