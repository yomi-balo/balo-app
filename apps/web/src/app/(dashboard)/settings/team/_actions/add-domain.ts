'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { partyDomainsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { emitPartyDomainAdded } from '@/lib/analytics/party-join';
import {
  assertRealCompany,
  domainInputSchema,
  domainParseError,
  manageGate,
  mapAddOutcomeToResult,
  revalidateTargetForParty,
  type ActionResult,
} from './domain-actions-shared';

/**
 * Admin add-domain (BAL-347). Gate: `MANAGE_MEMBERS` on the party (owner/admin only).
 * Validates + normalises the domain BEFORE the DB (invalid format never hits the
 * repo), forces `source: 'admin_added'`, maps the capture outcome to the design's
 * actionable copy, and — only on `captured` — emits the server analytics event and
 * revalidates the party's surface. The client re-checked `partyType`/`partyId` are
 * never trusted beyond the capability re-check here.
 */
export async function addPartyDomain(input: {
  partyType: 'company' | 'agency';
  partyId: string;
  domain: string;
}): Promise<ActionResult> {
  let session;
  try {
    session = await requireUser();
  } catch {
    return { success: false, error: 'You must be signed in to do this.' };
  }

  const parsed = domainInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: domainParseError(parsed.error) };
  }
  const { partyType, partyId, domain } = parsed.data;

  const denied = await manageGate(session, partyType, partyId);
  if (denied) {
    return denied;
  }

  // Company-only: mirror the page's `isPersonal` guard so a personal-workspace owner
  // (who holds MANAGE_MEMBERS on their own workspace) can't squat domains. The agency
  // path has no `isPersonal` concept and stays unguarded.
  if (partyType === 'company') {
    const personalDenied = await assertRealCompany(partyId);
    if (personalDenied) {
      return personalDenied;
    }
  }

  try {
    const result = await partyDomainsRepository.addDomain({
      partyType,
      partyId,
      domain,
      actorUserId: session.id,
    });

    if (result.outcome === 'captured') {
      emitPartyDomainAdded(partyType, 'admin_added', session.id);
      revalidatePath(revalidateTargetForParty(partyType));
    }

    return mapAddOutcomeToResult(result, domain);
  } catch (error) {
    log.error('Failed to add party domain', {
      partyType,
      partyId,
      actorUserId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not add this domain. Please try again.' };
  }
}
