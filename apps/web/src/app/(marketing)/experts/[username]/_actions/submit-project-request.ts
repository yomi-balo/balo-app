'use server';
import 'server-only';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { projectRequestsRepository, referenceDataRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';
import { projectRequestInputSchema } from './schemas';

/** Raw (pre-validation) input — `source` and arrays are optional (schema defaults them). */
type RawProjectRequestInput = z.input<typeof projectRequestInputSchema>;

interface SubmitProjectRequestResult {
  success: boolean;
  projectRequestId?: string;
  error?: string;
}

const GENERIC_ERROR = 'Something went wrong sending your request. Please try again.';

export const submitProjectRequestAction = withAuth(
  async (session, rawInput: RawProjectRequestInput): Promise<SubmitProjectRequestResult> => {
    try {
      const input = projectRequestInputSchema.parse(rawInput);

      // 1. Sanitise the HTML brief server-side (the security boundary), then
      //    reject if it collapses to empty/whitespace.
      const safeHtml = sanitizeProjectHtml(input.description);
      if (isDescriptionEmpty(safeHtml)) {
        log.warn('Project request description empty after sanitise', {
          userId: session.user.id,
        });
        return { success: false, error: 'Add a few words about what you need.' };
      }

      // 2. Validate tag/product IDs against the request's vertical taxonomy.
      //    Unknown IDs are rejected (not silently dropped) — surfaces tampering
      //    and keeps the junction `restrict` FKs from ever firing.
      const vertical = await referenceDataRepository.getSalesforceVertical();
      const [tagGroups, productCats] = await Promise.all([
        referenceDataRepository.getProjectTagsByVertical(vertical.id),
        referenceDataRepository.getProductsByVertical(vertical.id),
      ]);

      const allowedTagIds = new Set(tagGroups.flatMap((g) => g.tags.map((t) => t.id)));
      const allowedProductIds = new Set(productCats.flatMap((c) => c.products.map((p) => p.id)));

      const unknownTagIds = input.tagIds.filter((id) => !allowedTagIds.has(id));
      const unknownProductIds = input.productIds.filter((id) => !allowedProductIds.has(id));
      if (unknownTagIds.length > 0 || unknownProductIds.length > 0) {
        log.warn('Project request rejected — unknown taxonomy ids', {
          userId: session.user.id,
          unknownTagIds,
          unknownProductIds,
        });
        return { success: false, error: 'Some of your selections are no longer available.' };
      }

      // 3. Resolve the expert (direct only). companyId/createdByUserId are from
      //    the session, never client-supplied.
      const expertProfileId = input.sendTo === 'direct' ? input.expertProfileId : null;

      // 4. Persist request + tags + products + documents in one transaction.
      const created = await projectRequestsRepository.createProjectRequest({
        request: {
          companyId: session.user.companyId,
          createdByUserId: session.user.id,
          sendTo: input.sendTo,
          expertProfileId,
          status: 'requested',
          source: input.source,
          title: input.title,
          description: safeHtml,
          // Optional budget/timeline (A1 captures them, AUD-fixed — the form has
          // no currency picker yet; the column exists for a future multi-currency
          // ticket). Nullable, so omitting them preserves the existing contract.
          budgetMinCents: input.budgetMinCents,
          budgetMaxCents: input.budgetMaxCents,
          budgetCurrency: 'aud',
          timeline: input.timeline,
        },
        tagIds: input.tagIds,
        productIds: input.productIds,
        documents: input.documents.map((d) => ({
          r2Key: d.r2Key,
          fileName: d.fileName,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
        })),
      });

      log.info('Project request submitted', {
        userId: session.user.id,
        companyId: session.user.companyId,
        expertProfileId,
        projectRequestId: created.id,
        source: input.source,
        sendTo: input.sendTo,
        tagCount: input.tagIds.length,
        productCount: input.productIds.length,
        documentCount: input.documents.length,
        // Capture presence only — never the amounts.
        hasBudget: input.budgetMinCents !== null || input.budgetMaxCents !== null,
        hasTimeline: input.timeline !== null,
      });

      // 5. Publish the routing-appropriate event (fire-and-forget — a
      //    notification failure must not fail the submit).
      if (input.sendTo === 'direct' && expertProfileId) {
        publishNotificationEvent('project.request_submitted', {
          correlationId: created.id,
          projectRequestId: created.id,
          expertProfileId,
          companyId: session.user.companyId,
          title: created.title,
          sendTo: 'direct',
          tagIds: input.tagIds,
          productIds: input.productIds,
          documentCount: input.documents.length,
        }).catch(() => {
          // publishNotificationEvent logs internally
        });
      } else {
        publishNotificationEvent('project.match_requested', {
          correlationId: created.id,
          projectRequestId: created.id,
          companyId: session.user.companyId,
          title: created.title,
          tagIds: input.tagIds,
          productIds: input.productIds,
          documentCount: input.documents.length,
        }).catch(() => {
          // publishNotificationEvent logs internally
        });
      }

      return { success: true, projectRequestId: created.id };
    } catch (error) {
      log.error('Project request submission failed', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: GENERIC_ERROR };
    }
  }
);
