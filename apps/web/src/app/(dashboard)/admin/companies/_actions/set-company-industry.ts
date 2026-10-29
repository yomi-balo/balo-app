'use server';
import 'server-only';

import { z } from 'zod';
import { companiesRepository } from '@balo/db';
import type { CompanyDetailsActionResult } from '../_lib/company-details-types';
import { requireCompanyDetailsManager } from './_shared/require-company-details-manager';
import {
  COMPANY_GONE_ERROR,
  INDUSTRY_UNAVAILABLE_ERROR,
  INVALID_REQUEST,
  afterCompanyDetailsChange,
  denied,
  failure,
  saveFailed,
} from './_shared/company-details-action';

const inputSchema = z
  .object({
    companyId: z.uuid(),
    industryId: z.uuid().nullable(),
  })
  .strict();

/**
 * Balo staff set or clear a company's industry. The repository locks the row, refuses a retired
 * industry, and writes the audit row in the same transaction; an unchanged value is a no-op.
 */
export async function setCompanyIndustryAction(
  input: z.infer<typeof inputSchema>
): Promise<CompanyDetailsActionResult> {
  const auth = await requireCompanyDetailsManager();
  if (!auth.ok) return denied(auth.error);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure(INVALID_REQUEST);
  const { companyId, industryId } = parsed.data;

  let outcome: Awaited<ReturnType<typeof companiesRepository.setIndustry>>;
  try {
    outcome = await companiesRepository.setIndustry({
      companyId,
      industryId,
      actorUserId: auth.user.id,
    });
  } catch (error) {
    return saveFailed(
      'Failed to set company industry',
      { companyId, actorUserId: auth.user.id },
      error
    );
  }

  switch (outcome.outcome) {
    case 'company_not_found':
      return failure(COMPANY_GONE_ERROR, 'not_found');
    case 'industry_unavailable':
      return failure(INDUSTRY_UNAVAILABLE_ERROR, 'industry_unavailable');
    case 'unchanged':
      return {
        success: true,
        message: `${outcome.companyName} already has that industry, so nothing changed.`,
      };
    case 'changed': {
      afterCompanyDetailsChange({
        kind: 'industry',
        actorUserId: auth.user.id,
        companyId,
        cleared: outcome.to === null,
      });
      return {
        success: true,
        message:
          outcome.toName === null
            ? `${outcome.companyName}'s industry was cleared.`
            : `${outcome.companyName}'s industry is now ${outcome.toName}.`,
      };
    }
    default:
      return outcome satisfies never;
  }
}
