import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  partyDomainsStaffRepository,
  type PartyDomainSource,
  type StaffDomainOwner,
  type StaffPartySummary,
} from '@balo/db';
import { DOMAIN_EMPTY_MESSAGE, cleanDomainInput, isValidDomainFormat } from '@/lib/domain-input';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  emitPartyDomainAdded,
  emitPartyDomainReassigned,
  emitPartyDomainRemoved,
} from '@/lib/analytics/party-join';
import { personName } from '../../_lib/staff-domain-view';
import type {
  ConflictOwnerView,
  StaffDomainActionResult,
  StaffPartyType,
} from '../../_lib/staff-domain-types';

// ── Input schemas ──────────────────────────────────────────────────────────────────────

export const partyTypeSchema = z.enum(['company', 'agency']);
export const partyIdSchema = z.uuid();
/** Trimmed free text saved to the audit log. Blank is allowed here; callers decide if it is required. */
export const reasonSchema = z.string().trim().max(1000);
/** The raw domain field; `parseDomain` cleans and validates it. */
export const rawDomainSchema = z.string().max(253);

// ── Copy ───────────────────────────────────────────────────────────────────────────────

export const INVALID_REQUEST = 'Invalid request.';
export const DOMAIN_FORMAT_ERROR = 'Enter a domain like acme.co.nz, without https:// or @.';
export const REASON_REQUIRED_ERROR = 'Add a reason so the audit log shows why this changed.';
export const SAVE_FAILED_ERROR = "Couldn't save that change. Nothing was changed — try again.";
export const ALREADY_REMOVED_ERROR = 'That domain was already removed.';

export const blockedDomainError = (domain: string): string =>
  `${domain} is a personal email provider, so it can’t identify a company or agency.`;
export const alreadyOnPartyError = (domain: string, partyName: string): string =>
  `${domain} is already on ${partyName}.`;
export const staleDomainError = (domain: string): string =>
  `${domain} changed hands while you were looking. Check it again before reassigning.`;
export const personalWorkspaceError = (partyName: string): string =>
  `${partyName} is a personal workspace, so a domain on it would never match anyone.`;

// ── Result builders ────────────────────────────────────────────────────────────────────

export function denied(error: string): StaffDomainActionResult {
  return { success: false, error, code: 'denied' };
}

export function fieldError(field: 'domain' | 'reason', error: string): StaffDomainActionResult {
  return { success: false, error, field };
}

export function failure(error: string, code?: 'not_found'): StaffDomainActionResult {
  return code === undefined ? { success: false, error } : { success: false, error, code };
}

export function reasonRequired(): StaffDomainActionResult {
  return fieldError('reason', REASON_REQUIRED_ERROR);
}

export function saveFailed(
  message: string,
  context: Record<string, unknown>,
  error: unknown
): StaffDomainActionResult {
  log.error(message, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return failure(SAVE_FAILED_ERROR);
}

// ── Domain input ───────────────────────────────────────────────────────────────────────

export function parseDomain(
  raw: string
): { ok: true; domain: string } | { ok: false; result: StaffDomainActionResult } {
  const domain = cleanDomainInput(raw);
  if (domain.length === 0) {
    return { ok: false, result: fieldError('domain', DOMAIN_EMPTY_MESSAGE) };
  }
  if (!isValidDomainFormat(domain)) {
    return { ok: false, result: fieldError('domain', DOMAIN_FORMAT_ERROR) };
  }
  return { ok: true, domain };
}

// ── Party + owner projections ──────────────────────────────────────────────────────────

export interface PartyTarget {
  partyType: StaffPartyType;
  partyId: string;
  partyName: string;
  isPersonal: boolean;
}

export function toPartyTarget(summary: StaffPartySummary): PartyTarget {
  return {
    partyType: summary.partyType,
    partyId: summary.partyId,
    partyName: summary.name,
    isPersonal: summary.isPersonal,
  };
}

export async function loadPartyTarget(
  partyType: StaffPartyType,
  partyId: string
): Promise<PartyTarget | undefined> {
  const summary = await partyDomainsStaffRepository.getPartyForStaff(partyType, partyId);
  return summary === undefined ? undefined : toPartyTarget(summary);
}

export function toOwnerView(owner: StaffDomainOwner): ConflictOwnerView {
  return {
    domainId: owner.domainId,
    partyType: owner.partyType,
    partyId: owner.partyId,
    partyName: owner.partyName,
    memberCount: owner.memberCount,
    source: owner.source,
    createdAt: owner.createdAt.toISOString(),
    createdByName: personName(owner.createdBy),
  };
}

export function ownedByOther(owner: StaffDomainOwner): StaffDomainActionResult {
  return {
    success: false,
    error: `${owner.domain} belongs to ${owner.partyName}`,
    code: 'owned_by_other',
    owner: toOwnerView(owner),
  };
}

// ── Post-commit side effects ───────────────────────────────────────────────────────────

type PartyRefWithName = Pick<PartyTarget, 'partyType' | 'partyId' | 'partyName'>;

export type DomainChange =
  | {
      kind: 'added';
      actorUserId: string;
      party: PartyRefWithName;
      domainId: string;
      domain: string;
    }
  | {
      kind: 'removed';
      actorUserId: string;
      party: PartyRefWithName;
      domainId: string;
      domain: string;
      source: PartyDomainSource;
    }
  | {
      kind: 'reassigned';
      actorUserId: string;
      from: PartyRefWithName;
      to: PartyRefWithName;
      removedDomainId: string;
      addedDomainId: string;
      domain: string;
    };

export function successMessage(change: DomainChange): string {
  switch (change.kind) {
    case 'added':
      return `${change.domain} added to ${change.party.partyName}. Owners and admins have been notified.`;
    case 'removed':
      return `${change.domain} removed from ${change.party.partyName}. Owners and admins have been notified.`;
    case 'reassigned':
      return `${change.domain} moved from ${change.from.partyName} to ${change.to.partyName}. Owners and admins of both have been notified.`;
    default:
      return change satisfies never;
  }
}

/** Bound of `partyName` in the notification publish schema (`apps/api` `schema.ts`). */
export const PARTY_NAME_PUBLISH_MAX = 200;

export function truncatePartyName(name: string): string {
  return name.length > PARTY_NAME_PUBLISH_MAX
    ? `${name.slice(0, PARTY_NAME_PUBLISH_MAX - 1)}…`
    : name;
}

function publishDomainEvent(
  event: 'party.domain_added' | 'party.domain_removed',
  correlationId: string,
  party: PartyRefWithName,
  domain: string
): void {
  publishNotificationEvent(event, {
    correlationId,
    partyType: party.partyType,
    partyId: party.partyId,
    partyName: truncatePartyName(party.partyName),
    domain,
  }).catch(() => {
    // publishNotificationEvent logs internally
  });
}

function revalidateParty(party: PartyRefWithName): void {
  revalidatePath(`/admin/domains/${party.partyType}/${party.partyId}`);
  revalidatePath(party.partyType === 'company' ? '/settings/team' : '/expert/settings');
}

function sideEffectSteps(change: DomainChange): Array<[string, () => void]> {
  switch (change.kind) {
    case 'added':
      return [
        [
          'log',
          () =>
            log.info('Party domain added by staff', {
              partyType: change.party.partyType,
              partyId: change.party.partyId,
              domainId: change.domainId,
              actorUserId: change.actorUserId,
            }),
        ],
        [
          'analytics',
          () => emitPartyDomainAdded(change.party.partyType, 'admin_added', change.actorUserId),
        ],
        [
          'publish',
          () =>
            publishDomainEvent('party.domain_added', change.domainId, change.party, change.domain),
        ],
        ['revalidate', () => revalidateParty(change.party)],
      ];
    case 'removed':
      return [
        [
          'log',
          () =>
            log.info('Party domain removed by staff', {
              partyType: change.party.partyType,
              partyId: change.party.partyId,
              domainId: change.domainId,
              actorUserId: change.actorUserId,
            }),
        ],
        [
          'analytics',
          () => emitPartyDomainRemoved(change.party.partyType, change.source, change.actorUserId),
        ],
        [
          'publish',
          () =>
            publishDomainEvent(
              'party.domain_removed',
              change.domainId,
              change.party,
              change.domain
            ),
        ],
        ['revalidate', () => revalidateParty(change.party)],
      ];
    case 'reassigned':
      return [
        [
          'log',
          () =>
            log.info('Party domain reassigned by staff', {
              fromPartyType: change.from.partyType,
              fromPartyId: change.from.partyId,
              toPartyType: change.to.partyType,
              toPartyId: change.to.partyId,
              removedDomainId: change.removedDomainId,
              addedDomainId: change.addedDomainId,
              actorUserId: change.actorUserId,
            }),
        ],
        [
          'analytics',
          () =>
            emitPartyDomainReassigned(
              change.from.partyType,
              change.to.partyType,
              change.actorUserId
            ),
        ],
        [
          'publish removed',
          () =>
            publishDomainEvent(
              'party.domain_removed',
              change.removedDomainId,
              change.from,
              change.domain
            ),
        ],
        [
          'publish added',
          () =>
            publishDomainEvent(
              'party.domain_added',
              change.addedDomainId,
              change.to,
              change.domain
            ),
        ],
        ['revalidate from', () => revalidateParty(change.from)],
        ['revalidate to', () => revalidateParty(change.to)],
      ];
    default:
      return change satisfies never;
  }
}

/**
 * Everything that follows a COMMITTED staff write: business log, analytics, notifications,
 * revalidation. Never throws — the write already happened, so a failure here must not be reported
 * back as "nothing was changed".
 */
export function afterDomainChange(change: DomainChange): void {
  for (const [step, run] of sideEffectSteps(change)) {
    try {
      run();
    } catch (error) {
      log.error('A post-commit step failed after a staff party-domain change', {
        kind: change.kind,
        step,
        actorUserId: change.actorUserId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
