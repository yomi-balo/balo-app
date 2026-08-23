'use server';
import 'server-only';

import { z } from 'zod';
import { caseEngagementsRepository, partyMembershipsRepository } from '@balo/db';
import { CAPABILITIES } from '@/lib/authz';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import type { RefetchOpenCasesInput, RefetchOpenCasesResult } from './refetch-open-cases-types';

/**
 * BAL-400 (Phase 4 companion to Decision 5) — the booking wrapper's company-picker "choose a
 * company, THEN resolve open cases" second read, flagged as unbuilt by the slice-2 report.
 * `loadBookingContext`'s `choose_company` arm deliberately DEFERS the open-cases read (a case
 * is company-scoped, so a cross-company list would be incoherent) until the client picks one —
 * this is that resolution call, reusing the already-shipped
 * `caseEngagementsRepository.listOpenForCompanyAndExpert` the same way the `single_company` arm
 * does internally. Fail-closed on `companyId` outside the caller's eligible set (mirrors
 * Decision 5's IDOR guard in `book-consultation.ts`) — a client-supplied `companyId` is
 * untrusted until re-verified here, even though it can only ever be one this same actor's
 * `CompanyPicker` rendered.
 */

const inputSchema = z
  .object({
    expertProfileId: z.string().uuid(),
    companyId: z.string().uuid(),
  })
  .strict();

export async function refetchOpenCasesAction(
  rawInput: RefetchOpenCasesInput
): Promise<RefetchOpenCasesResult> {
  const user = await requireOnboardedUser();
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false };
  }
  const { expertProfileId, companyId } = parsed.data;

  const eligible = await partyMembershipsRepository.listCapabilityEligibleCompanies(
    user.id,
    CAPABILITIES.CONSUME_CREDITS
  );
  if (!eligible.some((c) => c.id === companyId)) {
    log.warn('Open-case refetch denied — company not eligible', { userId: user.id, companyId });
    return { ok: false };
  }

  try {
    const { openCases, resolvedCaseCount } =
      await caseEngagementsRepository.listOpenForCompanyAndExpert({ companyId, expertProfileId });
    return {
      ok: true,
      resolvedCaseCount,
      openCases: openCases.map((c) => ({
        engagementId: c.engagementId,
        title: c.title,
        createdAt: c.createdAt.toISOString(),
        lastActivityAt: c.lastActivityAt.toISOString(),
        consultationCount: c.consultationCount,
      })),
    };
  } catch (error) {
    log.error('Open-case refetch failed', {
      companyId,
      expertProfileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false };
  }
}
