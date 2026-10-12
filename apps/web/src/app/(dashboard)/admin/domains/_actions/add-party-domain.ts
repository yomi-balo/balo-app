'use server';
import 'server-only';

import { z } from 'zod';
import { partyDomainsStaffRepository, type StaffAddDomainResult } from '@balo/db';
import { isBlockedDomain } from '@balo/shared/domains';
import { log } from '@/lib/logging';
import type { StaffDomainActionResult } from '../_lib/staff-domain-types';
import { requirePartyDomainsManager } from './_shared/require-party-domains-manager';
import {
  INVALID_REQUEST,
  afterDomainChange,
  alreadyOnPartyError,
  blockedDomainError,
  denied,
  failure,
  fieldError,
  loadPartyTarget,
  ownedByOther,
  parseDomain,
  partyIdSchema,
  partyTypeSchema,
  personalWorkspaceError,
  rawDomainSchema,
  reasonRequired,
  reasonSchema,
  saveFailed,
  successMessage,
  SAVE_FAILED_ERROR,
  type PartyTarget,
} from './_shared/staff-domain-action';

const inputSchema = z
  .object({
    partyType: partyTypeSchema,
    partyId: partyIdSchema,
    domain: rawDomainSchema,
    reason: reasonSchema,
  })
  .strict();

type AddAttempt =
  | { kind: 'result'; result: StaffDomainActionResult }
  | { kind: 'added'; party: PartyTarget; domainId: string; domain: string };

const asResult = (result: StaffDomainActionResult): AddAttempt => ({ kind: 'result', result });

/**
 * A blank reason never writes. It answers the questions the form asks BEFORE it asks for a
 * reason — blocked provider, already on this party, owned by another party — so the conflict
 * panel appears first and the reason prompt second.
 */
async function probeBeforeReason(party: PartyTarget, domain: string): Promise<AddAttempt> {
  if (isBlockedDomain(domain)) return asResult(fieldError('domain', blockedDomainError(domain)));
  const owner = await partyDomainsStaffRepository.findLiveOwnerForStaff(domain);
  if (owner === undefined) return asResult(reasonRequired());
  if (owner.partyType === party.partyType && owner.partyId === party.partyId) {
    return asResult(fieldError('domain', alreadyOnPartyError(domain, party.partyName)));
  }
  return asResult(ownedByOther(owner));
}

async function resolveWriteOutcome(
  outcome: StaffAddDomainResult,
  party: PartyTarget,
  domain: string
): Promise<AddAttempt> {
  switch (outcome.outcome) {
    case 'added':
      return { kind: 'added', party, domainId: outcome.domainId, domain: outcome.domain };
    case 'already_on_party':
      return asResult(fieldError('domain', alreadyOnPartyError(domain, party.partyName)));
    case 'blocked_domain':
      return asResult(fieldError('domain', blockedDomainError(domain)));
    case 'personal_workspace':
      return asResult(failure(personalWorkspaceError(party.partyName)));
    case 'owned_by_other': {
      const owner = await partyDomainsStaffRepository.findLiveOwnerForStaff(domain);
      return asResult(owner === undefined ? failure(SAVE_FAILED_ERROR) : ownedByOther(owner));
    }
    case 'party_not_found':
    case 'not_applicable':
    case 'conflict_retry':
      log.warn('Staff party-domain add did not apply', {
        partyType: party.partyType,
        partyId: party.partyId,
        outcome: outcome.outcome,
      });
      return asResult(failure(SAVE_FAILED_ERROR));
    default:
      return outcome satisfies never;
  }
}

async function attemptAdd(
  input: z.infer<typeof inputSchema>,
  domain: string,
  actorUserId: string
): Promise<AddAttempt> {
  const party = await loadPartyTarget(input.partyType, input.partyId);
  if (party === undefined) return asResult(failure(SAVE_FAILED_ERROR));
  if (party.isPersonal) return asResult(failure(personalWorkspaceError(party.partyName)));
  if (input.reason === '') return probeBeforeReason(party, domain);

  const outcome = await partyDomainsStaffRepository.addDomain({
    partyType: input.partyType,
    partyId: input.partyId,
    domain,
    actorUserId,
    reason: input.reason,
  });
  return resolveWriteOutcome(outcome, party, domain);
}

/**
 * Balo staff add a domain to a company or agency. A blank reason is a read-only probe (see
 * `probeBeforeReason`); with a reason the repository writes the row and its audit row in one
 * transaction. A domain another party owns is returned as `owned_by_other` with the owner, and
 * the form follows up with `reassignPartyDomainAction`.
 */
export async function addPartyDomainAction(
  input: z.infer<typeof inputSchema>
): Promise<StaffDomainActionResult> {
  const auth = await requirePartyDomainsManager();
  if (!auth.ok) return denied(auth.error);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure(INVALID_REQUEST);
  const domainInput = parseDomain(parsed.data.domain);
  if (!domainInput.ok) return domainInput.result;

  let attempt: AddAttempt;
  try {
    attempt = await attemptAdd(parsed.data, domainInput.domain, auth.user.id);
  } catch (error) {
    return saveFailed(
      'Failed to add party domain',
      {
        partyType: parsed.data.partyType,
        partyId: parsed.data.partyId,
        actorUserId: auth.user.id,
      },
      error
    );
  }
  if (attempt.kind === 'result') return attempt.result;

  const change = {
    kind: 'added',
    actorUserId: auth.user.id,
    party: attempt.party,
    domainId: attempt.domainId,
    domain: attempt.domain,
  } as const;
  afterDomainChange(change);
  return { success: true, message: successMessage(change) };
}
