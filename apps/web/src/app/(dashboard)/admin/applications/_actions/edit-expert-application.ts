'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { expertsRepository } from '@balo/db';
import {
  PROJECT_COUNT_RANGES,
  EXPERT_LANGUAGES_MAX,
  EXPERT_INDUSTRIES_MAX,
} from '@balo/shared/experts';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { requireApplicationReviewer } from './_shared/require-application-reviewer';
import {
  APPLICATION_EDIT_GONE,
  APPLICATION_EDIT_NOT_EDITABLE,
  APPLICATION_EDIT_FAILURE,
  APPLICATION_EDIT_INVALID_EXPERIENCE,
  type EditApplicationActionResult,
} from './_shared/edit-outcome';

// ── Zod — a STRICT delta mirroring `StaffApplicationEdit` (`@balo/shared/experts`) ──

function hasNoDuplicates<T>(items: readonly T[], key: (item: T) => string): boolean {
  const seen = new Set(items.map(key));
  return seen.size === items.length;
}

function isValidProjectCount(value: number): boolean {
  return PROJECT_COUNT_RANGES.some((range) => range.min === value);
}

const currentYear = new Date().getFullYear();

const experienceEditSchema = z
  .object({
    yearStartedSalesforce: z.number().int().min(2000).max(currentYear),
    projectCountMin: z.number().int().refine(isValidProjectCount),
    projectLeadCountMin: z.number().int().refine(isValidProjectCount),
    isSalesforceMvp: z.boolean(),
    isSalesforceCta: z.boolean(),
    isCertifiedTrainer: z.boolean(),
  })
  .partial()
  .strict()
  .refine((experience) => Object.keys(experience).length > 0);
// No lead ≤ project refine here: the rule needs the stored counts as well as the delta, so it
// lives in the repository planner (`staffEditExperienceIsInvalid`), which checks the effective
// pair under the profile lock and only when the edit touches a count.

const languagesEditSchema = z
  .array(
    z
      .object({
        languageId: z.uuid(),
        proficiency: z.enum(['beginner', 'intermediate', 'advanced', 'native']),
      })
      .strict()
  )
  .max(EXPERT_LANGUAGES_MAX)
  .refine((languages) => hasNoDuplicates(languages, (l) => l.languageId));

const industryIdsEditSchema = z
  .array(z.uuid())
  .max(EXPERT_INDUSTRIES_MAX)
  .refine((ids) => hasNoDuplicates(ids, (id) => id));

const productRatingSchema = z
  .object({
    supportTypeId: z.uuid(),
    proficiency: z.number().int().min(0).max(10),
  })
  .strict();

const productsAddedEditSchema = z
  .array(
    z
      .object({
        productId: z.uuid(),
        // A staff-added product always carries a rating for every support type; `.min(1)`
        // makes an empty ratings array unrepresentable at the boundary.
        ratings: z
          .array(productRatingSchema)
          .min(1)
          .max(10)
          .refine((ratings) => hasNoDuplicates(ratings, (r) => r.supportTypeId)),
      })
      .strict()
  )
  .max(50)
  .refine((products) => hasNoDuplicates(products, (p) => p.productId));

const productsRemovedEditSchema = z
  .array(z.uuid())
  .max(100)
  .refine((ids) => hasNoDuplicates(ids, (id) => id));

const ratingsEditSchema = z
  .array(
    z
      .object({
        productId: z.uuid(),
        supportTypeId: z.uuid(),
        proficiency: z.number().int().min(0).max(10),
      })
      .strict()
  )
  .max(500)
  .refine((ratings) => hasNoDuplicates(ratings, (r) => `${r.productId}:${r.supportTypeId}`));

const certificationsAddedEditSchema = z
  .array(z.uuid())
  .max(100)
  .refine((ids) => hasNoDuplicates(ids, (id) => id));

const certificationsRemovedEditSchema = z
  .array(z.uuid())
  .max(100)
  .refine((ids) => hasNoDuplicates(ids, (id) => id));

const staffApplicationEditSchema = z
  .object({
    experience: experienceEditSchema,
    languages: languagesEditSchema,
    industryIds: industryIdsEditSchema,
    productsAdded: productsAddedEditSchema,
    productsRemoved: productsRemovedEditSchema,
    ratings: ratingsEditSchema,
    certificationsAdded: certificationsAddedEditSchema,
    certificationsRemoved: certificationsRemovedEditSchema,
  })
  .partial()
  .strict()
  .refine((edit) => Object.keys(edit).length > 0)
  .refine((edit) => {
    if (edit.productsRemoved === undefined || edit.productsRemoved.length === 0) return true;
    const removed = new Set(edit.productsRemoved);
    const addedIds = edit.productsAdded?.map((p) => p.productId) ?? [];
    const ratedIds = edit.ratings?.map((r) => r.productId) ?? [];
    return [...addedIds, ...ratedIds].every((id) => !removed.has(id));
  })
  .refine((edit) => {
    if (edit.certificationsAdded === undefined || edit.certificationsRemoved === undefined) {
      return true;
    }
    const removed = new Set(edit.certificationsRemoved);
    return edit.certificationsAdded.every((id) => !removed.has(id));
  });

const inputSchema = z
  .object({
    expertProfileId: z.uuid(),
    edit: staffApplicationEditSchema,
  })
  .strict();

/**
 * BAL-593 — a Balo-staff edit of an expert application. Gated on `REVIEW_EXPERT_APPLICATIONS`,
 * re-resolved here exactly like `declineExpertApplicationAction` — see that action's docblock
 * for why the gate is re-checked rather than inherited from `admin/layout.tsx`.
 *
 * The repository (`expertsRepository.editApplicationAsStaff`) is the ONLY place that reads the
 * locked row, plans the delta into sections/counts, and writes the audit row — this action never
 * computes a before/after diff itself (H3). `no_changes` is a success with nothing written, not
 * a failure: the delta planned to nothing, so there is no audit row and no email.
 *
 * ⚠ THE EMAIL FIRES ONLY WHEN THE APPLICATION IS `approved` (H5/H3) — a pending edit changes the
 * application staff still have to decide on, never a profile the applicant can see yet.
 */
export async function editExpertApplicationAction(
  input: z.infer<typeof inputSchema>
): Promise<EditApplicationActionResult> {
  const auth = await requireApplicationReviewer();
  if (!auth.ok) {
    return { success: false, error: auth.error, code: 'denied' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { expertProfileId, edit } = parsed.data;

  let result: Awaited<ReturnType<typeof expertsRepository.editApplicationAsStaff>>;
  try {
    result = await expertsRepository.editApplicationAsStaff({
      expertProfileId,
      actorUserId: auth.user.id,
      edit,
    });
  } catch (error) {
    log.error('Failed to edit expert application', {
      expertProfileId,
      actorUserId: auth.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: APPLICATION_EDIT_FAILURE };
  }

  // Everything below runs OUTSIDE the try above: once the repository call has returned, the
  // write (if any) already committed or was refused as a discriminated outcome, never a throw.
  // A failure in the steps below (logging, publish, revalidation) must never be reported back
  // as "Nothing was written" — that would be false for `edited`.
  switch (result.outcome) {
    case 'not_found':
      return { success: false, error: APPLICATION_EDIT_GONE, code: 'gone' };
    case 'not_editable':
      return { success: false, error: APPLICATION_EDIT_NOT_EDITABLE, code: 'not_editable' };
    case 'invalid_experience':
      return {
        success: false,
        error: APPLICATION_EDIT_INVALID_EXPERIENCE,
        code: 'invalid_experience',
      };
    case 'no_changes':
      return { success: true, changed: false };
    case 'edited':
      break;
    default:
      return result satisfies never;
  }

  log.info('Expert application edited', {
    expertProfileId,
    actorUserId: auth.user.id,
    applicantUserId: result.applicantUserId,
    applicationStatus: result.applicationStatus,
    sections: result.sections,
    auditEventId: result.auditEventId,
  });

  if (result.applicationStatus === 'approved') {
    // ⚠ `.`-JOINED, NEVER `:`-JOINED — colon-free by construction, and per WRITE (not per
    // state) so a second edit never dedups against a retained completed BullMQ job.
    const correlationId = `expert-application-edited.${expertProfileId}.${result.auditEventId}`;
    publishNotificationEvent('expert.application_edited', {
      correlationId,
      userId: result.applicantUserId,
      expertProfileId,
      sections: result.sections,
    }).catch(() => {
      // publishNotificationEvent logs internally
    });
  }

  revalidatePath('/admin/applications');
  revalidatePath(`/admin/applications/${expertProfileId}`);

  return {
    success: true,
    changed: true,
    live: result.applicationStatus === 'approved',
    analytics: {
      status: result.applicationStatus === 'approved' ? 'approved' : 'pending',
      sections: result.sections,
      ratings_adjusted: result.counts.ratingsAdjusted,
      products_added: result.counts.productsAdded,
      products_removed: result.counts.productsRemoved,
      certifications_added: result.counts.certificationsAdded,
      certifications_removed: result.counts.certificationsRemoved,
    },
  };
}
