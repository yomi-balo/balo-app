'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { companiesRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { emitDomainJoinModeChanged } from '@/lib/analytics/party-join';
import { assertRealCompany, type ActionResult } from './domain-actions-shared';

const setJoinModeSchema = z.object({
  companyId: z.uuid(),
  mode: z.enum(['auto', 'request', 'off']),
});

/**
 * Set the company's domain join mode (BAL-347) — structurally COMPANY-ONLY: there is
 * no `partyType` param and the gate reads `{ companyId }`, so an agency id cannot be
 * passed. Gate: `MANAGE_MEMBERS` on the company. Emits analytics + revalidates only
 * when the mode actually `changed` (a same-mode write is a success no-op with no
 * event). Not-found / DB errors map to a friendly retryable message.
 */
export async function setCompanyJoinMode(input: {
  companyId: string;
  mode: 'auto' | 'request' | 'off';
}): Promise<ActionResult> {
  let session;
  try {
    session = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You must be signed in to do this.' };
  }

  const parsed = setJoinModeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { companyId, mode } = parsed.data;

  const allowed = await hasCapability(session, CAPABILITIES.MANAGE_MEMBERS, { companyId });
  if (!allowed) {
    return { success: false, error: 'You do not have permission to do this.' };
  }

  // Company-only action → always mirror the page's `isPersonal` guard so a
  // personal-workspace owner can't flip join modes on a dormant surface.
  const personalDenied = await assertRealCompany(companyId);
  if (personalDenied) {
    return personalDenied;
  }

  try {
    const result = await companiesRepository.setDomainJoinMode(companyId, mode, session.id);

    if (result.changed) {
      emitDomainJoinModeChanged(result.previous, result.next, session.id);
      revalidatePath('/settings/team');
    }

    return { success: true };
  } catch (error) {
    log.error('Failed to set company join mode', {
      companyId,
      mode,
      actorUserId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not update join mode. Please try again.' };
  }
}
