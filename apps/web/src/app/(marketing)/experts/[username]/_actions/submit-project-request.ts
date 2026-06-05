'use server';
import 'server-only';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { projectRequestsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { projectRequestInputSchema } from './schemas';

/** Raw (pre-validation) input — `source` is optional because the schema defaults it. */
type RawProjectRequestInput = z.input<typeof projectRequestInputSchema>;

interface SubmitProjectRequestResult {
  success: boolean;
  projectRequestId?: string;
  error?: string;
}

export const submitProjectRequestAction = withAuth(
  async (session, rawInput: RawProjectRequestInput): Promise<SubmitProjectRequestResult> => {
    try {
      const input = projectRequestInputSchema.parse(rawInput);

      const created = await projectRequestsRepository.createProjectRequest({
        // Owner + creator are derived from the session, never client-supplied.
        companyId: session.user.companyId,
        expertProfileId: input.expertProfileId,
        createdByUserId: session.user.id,
        status: 'submitted',
        source: input.source,
        title: input.title,
        description: input.description,
        focusArea: input.focusArea ?? null,
        budget: input.budget ?? null,
        timeline: input.timeline ?? null,
      });

      log.info('Project request submitted', {
        userId: session.user.id,
        companyId: session.user.companyId,
        expertProfileId: input.expertProfileId,
        projectRequestId: created.id,
        source: input.source,
      });

      // Fire-and-forget — a notification failure must not fail the submit.
      publishNotificationEvent('project.request_submitted', {
        correlationId: created.id,
        projectRequestId: created.id,
        expertProfileId: input.expertProfileId,
        companyId: session.user.companyId,
        title: created.title,
      }).catch(() => {
        // publishNotificationEvent logs internally
      });

      return { success: true, projectRequestId: created.id };
    } catch (error) {
      log.error('Project request submission failed', {
        userId: session.user.id,
        expertProfileId: rawInput?.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        error: 'Something went wrong sending your request. Please try again.',
      };
    }
  }
);
