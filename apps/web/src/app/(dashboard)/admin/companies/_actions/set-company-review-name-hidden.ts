'use server';
import 'server-only';

import { z } from 'zod';
import { companiesRepository } from '@balo/db';
import type { CompanyDetailsActionResult } from '../_lib/company-details-types';
import { requireCompanyDetailsManager } from './_shared/require-company-details-manager';
import {
  COMPANY_GONE_ERROR,
  INVALID_REQUEST,
  afterCompanyDetailsChange,
  denied,
  failure,
  personalWorkspaceError,
  saveFailed,
} from './_shared/company-details-action';

const inputSchema = z
  .object({
    companyId: z.uuid(),
    hidden: z.boolean(),
  })
  .strict();

/**
 * Balo staff take a company's name off every review, or let it show again. Turning it back on only
 * lifts the company-level block: each review still follows its own reviewer's choice. The
 * repository refuses a personal workspace and writes the audit row in the same transaction.
 */
export async function setCompanyReviewNameHiddenAction(
  input: z.infer<typeof inputSchema>
): Promise<CompanyDetailsActionResult> {
  const auth = await requireCompanyDetailsManager();
  if (!auth.ok) return denied(auth.error);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure(INVALID_REQUEST);
  const { companyId, hidden } = parsed.data;

  let outcome: Awaited<ReturnType<typeof companiesRepository.setReviewNameHidden>>;
  try {
    outcome = await companiesRepository.setReviewNameHidden({
      companyId,
      hidden,
      actorUserId: auth.user.id,
    });
  } catch (error) {
    return saveFailed(
      'Failed to change company review-name visibility',
      { companyId, hidden, actorUserId: auth.user.id },
      error
    );
  }

  switch (outcome.outcome) {
    case 'company_not_found':
      return failure(COMPANY_GONE_ERROR, 'not_found');
    case 'personal_workspace':
      return failure(personalWorkspaceError(outcome.companyName), 'personal_workspace');
    case 'unchanged':
      return {
        success: true,
        message: `Nothing changed — that's already set for ${outcome.companyName}.`,
      };
    case 'changed': {
      afterCompanyDetailsChange({
        kind: 'review_name',
        actorUserId: auth.user.id,
        companyId,
        hidden: outcome.hidden,
      });
      return {
        success: true,
        message: outcome.hidden
          ? `${outcome.companyName}'s name is now off every review.`
          : `${outcome.companyName}'s name can show on reviews again, where each reviewer chose to show it.`,
      };
    }
    default:
      return outcome satisfies never;
  }
}
