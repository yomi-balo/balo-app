'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { partyDomainsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { emitPartyDomainRemoved } from '@/lib/analytics/party-join';
import {
  assertRealCompany,
  manageGate,
  revalidateTargetForParty,
  type ActionResult,
} from './domain-actions-shared';

const removeInputSchema = z.object({
  partyType: z.enum(['company', 'agency']),
  partyId: z.uuid(),
  domainId: z.uuid(),
});

/**
 * Admin remove-domain (BAL-347). Gate: `MANAGE_MEMBERS` on the party. The repo
 * soft-remove is PARTY-SCOPED (the WHERE matches party_type + party_id), so a
 * guessed cross-party id resolves to `not_found` — mapped to a friendly,
 * idempotent-safe error. On `removed`, emits the server analytics event + revalidates
 * the party's surface. The "removing the last domain turns off join by domain"
 * caution is pure client UX — there is no server branch for it.
 */
export async function removePartyDomain(input: {
  partyType: 'company' | 'agency';
  partyId: string;
  domainId: string;
}): Promise<ActionResult> {
  let session;
  try {
    session = await requireUser();
  } catch {
    return { success: false, error: 'You must be signed in to do this.' };
  }

  const parsed = removeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { partyType, partyId, domainId } = parsed.data;

  const denied = await manageGate(session, partyType, partyId);
  if (denied) {
    return denied;
  }

  // Company-only: mirror the page's `isPersonal` guard (see add-domain). The agency
  // path has no `isPersonal` concept and stays unguarded.
  if (partyType === 'company') {
    const personalDenied = await assertRealCompany(partyId);
    if (personalDenied) {
      return personalDenied;
    }
  }

  try {
    const result = await partyDomainsRepository.removeDomain({
      domainId,
      partyType,
      partyId,
      actorUserId: session.id,
    });

    if (result.outcome === 'removed') {
      emitPartyDomainRemoved(partyType, session.id);
      revalidatePath(revalidateTargetForParty(partyType));
      return { success: true };
    }

    return { success: false, error: 'This domain could not be found.' };
  } catch (error) {
    log.error('Failed to remove party domain', {
      partyType,
      partyId,
      domainId,
      actorUserId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not remove this domain. Please try again.' };
  }
}
