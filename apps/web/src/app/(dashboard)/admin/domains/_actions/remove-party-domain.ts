'use server';
import 'server-only';

import { z } from 'zod';
import { partyDomainsStaffRepository, type StaffRemoveDomainResult } from '@balo/db';
import type { StaffDomainActionResult } from '../_lib/staff-domain-types';
import { requirePartyDomainsManager } from './_shared/require-party-domains-manager';
import {
  ALREADY_REMOVED_ERROR,
  INVALID_REQUEST,
  SAVE_FAILED_ERROR,
  afterDomainChange,
  denied,
  failure,
  loadPartyTarget,
  partyIdSchema,
  partyTypeSchema,
  reasonRequired,
  reasonSchema,
  saveFailed,
  successMessage,
  type PartyTarget,
} from './_shared/staff-domain-action';

const inputSchema = z
  .object({
    domainId: z.uuid(),
    partyType: partyTypeSchema,
    partyId: partyIdSchema,
    reason: reasonSchema,
  })
  .strict();

type RemoveAttempt =
  | { kind: 'result'; result: StaffDomainActionResult }
  | {
      kind: 'removed';
      party: PartyTarget;
      outcome: Extract<StaffRemoveDomainResult, { outcome: 'removed' }>;
    };

async function attemptRemove(
  actorUserId: string,
  input: z.infer<typeof inputSchema>
): Promise<RemoveAttempt> {
  const party = await loadPartyTarget(input.partyType, input.partyId);
  if (party === undefined) return { kind: 'result', result: failure(SAVE_FAILED_ERROR) };
  const outcome = await partyDomainsStaffRepository.removeDomain({ ...input, actorUserId });
  if (outcome.outcome === 'not_found') {
    return { kind: 'result', result: failure(ALREADY_REMOVED_ERROR, 'not_found') };
  }
  return { kind: 'removed', party, outcome };
}

/**
 * Balo staff remove a domain from a party. A reason is required; the repository soft-deletes the
 * row and writes the audit row in one transaction. Existing members are never touched.
 */
export async function removePartyDomainAction(
  input: z.infer<typeof inputSchema>
): Promise<StaffDomainActionResult> {
  const auth = await requirePartyDomainsManager();
  if (!auth.ok) return denied(auth.error);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure(INVALID_REQUEST);
  const { domainId, partyType, partyId, reason } = parsed.data;
  if (reason === '') return reasonRequired();

  let attempt: RemoveAttempt;
  try {
    attempt = await attemptRemove(auth.user.id, { domainId, partyType, partyId, reason });
  } catch (error) {
    return saveFailed(
      'Failed to remove party domain',
      { partyType, partyId, domainId, actorUserId: auth.user.id },
      error
    );
  }
  if (attempt.kind === 'result') return attempt.result;
  const { party, outcome } = attempt;

  const change = {
    kind: 'removed',
    actorUserId: auth.user.id,
    party,
    domainId,
    domain: outcome.domain,
    source: outcome.source,
  } as const;
  afterDomainChange(change);
  return { success: true, message: successMessage(change) };
}
