'use server';
import 'server-only';

import { z } from 'zod';
import { partyDomainsStaffRepository, type StaffReassignDomainResult } from '@balo/db';
import { log } from '@/lib/logging';
import type { StaffDomainActionResult } from '../_lib/staff-domain-types';
import { requirePartyDomainsManager } from './_shared/require-party-domains-manager';
import {
  INVALID_REQUEST,
  SAVE_FAILED_ERROR,
  afterDomainChange,
  denied,
  failure,
  loadPartyTarget,
  parseDomain,
  partyIdSchema,
  partyTypeSchema,
  personalWorkspaceError,
  rawDomainSchema,
  reasonRequired,
  reasonSchema,
  saveFailed,
  staleDomainError,
  successMessage,
  type PartyTarget,
} from './_shared/staff-domain-action';

const inputSchema = z
  .object({
    expectedDomainId: z.uuid(),
    fromPartyType: partyTypeSchema,
    fromPartyId: partyIdSchema,
    toPartyType: partyTypeSchema,
    toPartyId: partyIdSchema,
    domain: rawDomainSchema,
    reason: reasonSchema,
  })
  .strict();

type ReassignAttempt =
  | { kind: 'result'; result: StaffDomainActionResult; warn?: string }
  | {
      kind: 'reassigned';
      from: PartyTarget;
      to: PartyTarget;
      outcome: Extract<StaffReassignDomainResult, { outcome: 'reassigned' }>;
    };

function resolveReassignOutcome(
  outcome: StaffReassignDomainResult,
  from: PartyTarget,
  to: PartyTarget,
  domain: string
): ReassignAttempt {
  switch (outcome.outcome) {
    case 'reassigned':
      return { kind: 'reassigned', from, to, outcome };
    case 'stale':
      return {
        kind: 'result',
        result: { success: false, error: staleDomainError(domain), code: 'stale' },
        warn: 'Staff party-domain reassign was stale',
      };
    case 'personal_workspace':
      return { kind: 'result', result: failure(personalWorkspaceError(to.partyName)) };
    case 'same_party':
    case 'party_not_found':
    case 'conflict_retry':
      return {
        kind: 'result',
        result: failure(SAVE_FAILED_ERROR),
        warn: `Staff party-domain reassign did not apply: ${outcome.outcome}`,
      };
    default:
      return outcome satisfies never;
  }
}

async function attemptReassign(
  data: z.infer<typeof inputSchema>,
  actorUserId: string,
  domain: string
): Promise<ReassignAttempt> {
  const [from, to] = await Promise.all([
    loadPartyTarget(data.fromPartyType, data.fromPartyId),
    loadPartyTarget(data.toPartyType, data.toPartyId),
  ]);
  if (from === undefined || to === undefined) {
    return { kind: 'result', result: failure(SAVE_FAILED_ERROR) };
  }
  if (to.isPersonal) {
    return { kind: 'result', result: failure(personalWorkspaceError(to.partyName)) };
  }
  const outcome = await partyDomainsStaffRepository.reassignDomain({
    expected: {
      domainId: data.expectedDomainId,
      partyType: data.fromPartyType,
      partyId: data.fromPartyId,
    },
    to: { partyType: data.toPartyType, partyId: data.toPartyId },
    actorUserId,
    reason: data.reason,
  });
  return resolveReassignOutcome(outcome, from, to, domain);
}

/**
 * Balo staff move a domain from the party that owns it to another. `expected*` is the owner the
 * staffer was shown; if the row has since been removed or moved the repository answers `stale`
 * and nothing is written. `domain` is only used to word the stale message — the row is matched
 * by id and owner, never by the domain string.
 */
export async function reassignPartyDomainAction(
  input: z.infer<typeof inputSchema>
): Promise<StaffDomainActionResult> {
  const auth = await requirePartyDomainsManager();
  if (!auth.ok) return denied(auth.error);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure(INVALID_REQUEST);
  const data = parsed.data;
  const domainInput = parseDomain(data.domain);
  if (!domainInput.ok) return domainInput.result;
  if (data.reason === '') return reasonRequired();

  const context = {
    expectedDomainId: data.expectedDomainId,
    fromPartyId: data.fromPartyId,
    toPartyId: data.toPartyId,
    actorUserId: auth.user.id,
  };
  let attempt: ReassignAttempt;
  try {
    attempt = await attemptReassign(data, auth.user.id, domainInput.domain);
  } catch (error) {
    return saveFailed('Failed to reassign party domain', context, error);
  }
  if (attempt.kind === 'result') {
    if (attempt.warn !== undefined) log.warn(attempt.warn, context);
    return attempt.result;
  }
  const { from, to, outcome } = attempt;

  const change = {
    kind: 'reassigned',
    actorUserId: auth.user.id,
    from,
    to,
    removedDomainId: outcome.removedDomainId,
    addedDomainId: outcome.addedDomainId,
    domain: outcome.domain,
  } as const;
  afterDomainChange(change);
  return { success: true, message: successMessage(change) };
}
