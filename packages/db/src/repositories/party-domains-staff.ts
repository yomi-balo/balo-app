import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { isBlockedDomain, normalizeDomain } from '@balo/shared/domains';
import { db } from '../client';
import {
  agencies,
  agencyMembers,
  auditEvents,
  companies,
  companyMembers,
  partyDomains,
  users,
  type PartyDomainSource,
  type PartyType,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';

/**
 * Audit actions written by the Balo-staff domain writers. The reason text lives in
 * `audit_events.metadata.reason`, never in the action string.
 */
export const PARTY_DOMAIN_STAFF_AUDIT = {
  ADDED: 'party_domain.staff_added',
  REMOVED: 'party_domain.staff_removed',
} as const;

export interface PartyRef {
  partyType: PartyType;
  partyId: string;
}

// ── Write inputs / outcomes ───────────────────────────────────────────────────────────

export interface StaffAddDomainInput extends PartyRef {
  domain: string;
  actorUserId: string;
  reason: string;
}

export type StaffAddDomainResult =
  | { outcome: 'added'; domainId: string; domain: string }
  | { outcome: 'already_on_party' }
  | {
      outcome: 'owned_by_other';
      ownerDomainId: string;
      ownerPartyType: PartyType;
      ownerPartyId: string;
    }
  | { outcome: 'blocked_domain' }
  | { outcome: 'personal_workspace' }
  | { outcome: 'party_not_found' }
  | { outcome: 'not_applicable' }
  | { outcome: 'conflict_retry' };

export interface StaffRemoveDomainInput extends PartyRef {
  domainId: string;
  actorUserId: string;
  reason: string;
}

export type StaffRemoveDomainResult =
  | { outcome: 'removed'; domain: string; source: PartyDomainSource }
  | { outcome: 'not_found' };

export interface StaffReassignDomainInput {
  expected: PartyRef & { domainId: string };
  to: PartyRef;
  actorUserId: string;
  reason: string;
}

export type StaffReassignDomainResult =
  | {
      outcome: 'reassigned';
      removedDomainId: string;
      addedDomainId: string;
      domain: string;
      removedSource: PartyDomainSource;
    }
  | { outcome: 'stale' }
  | { outcome: 'same_party' }
  | { outcome: 'personal_workspace' }
  | { outcome: 'party_not_found' }
  | { outcome: 'conflict_retry' };

// ── Read shapes ───────────────────────────────────────────────────────────────────────

export interface StaffPartySummary extends PartyRef {
  name: string;
  isPersonal: boolean;
  memberCount: number;
}

/** `party_admin` marks a legacy self-serve row: `admin_added` with no staff audit row. */
export type StaffDomainAddedVia = 'signup' | 'balo' | 'party_admin';

export interface StaffPartyDomainRow {
  id: string;
  domain: string;
  source: PartyDomainSource;
  createdAt: Date;
  createdBy: { firstName: string | null; lastName: string | null } | null;
  addedVia: StaffDomainAddedVia;
  reason: string | null;
}

export interface StaffDomainOwner extends PartyRef {
  domainId: string;
  domain: string;
  partyName: string;
  memberCount: number;
  source: PartyDomainSource;
  createdAt: Date;
  createdBy: { firstName: string | null; lastName: string | null } | null;
}

// ── Private helpers ───────────────────────────────────────────────────────────────────

/** Thrown inside a reassign transaction to roll it back; mapped to `conflict_retry`. */
class ReassignInsertLostError extends Error {
  constructor() {
    super('reassign target insert lost the domain slot');
    this.name = 'ReassignInsertLostError';
  }
}

type TargetPartyCheck = 'ok' | 'personal_workspace' | 'party_not_found';

/** Validates the party a domain is about to land on. `companies` has no `deleted_at`. */
async function assertTargetParty(tx: DbExecutor, ref: PartyRef): Promise<TargetPartyCheck> {
  if (ref.partyType === 'company') {
    const [company] = await tx
      .select({ isPersonal: companies.isPersonal })
      .from(companies)
      .where(eq(companies.id, ref.partyId))
      .limit(1);
    if (company === undefined) return 'party_not_found';
    return company.isPersonal ? 'personal_workspace' : 'ok';
  }
  const [agency] = await tx
    .select({ id: agencies.id })
    .from(agencies)
    .where(eq(agencies.id, ref.partyId))
    .limit(1);
  return agency === undefined ? 'party_not_found' : 'ok';
}

/** `ON CONFLICT DO NOTHING` insert with the partial-unique predicate as arbiter. */
async function insertLive(
  tx: DbExecutor,
  input: PartyRef & { domain: string; actorUserId: string }
): Promise<string | undefined> {
  const [inserted] = await tx
    .insert(partyDomains)
    .values({
      partyType: input.partyType,
      partyId: input.partyId,
      domain: input.domain,
      source: 'admin_added',
      createdByUserId: input.actorUserId,
    })
    .onConflictDoNothing({
      target: partyDomains.domain,
      where: isNull(partyDomains.deletedAt),
    })
    .returning({ id: partyDomains.id });
  return inserted?.id;
}

/** Party-scoped soft delete: the row must still be live AND owned by the stated party. */
async function softDeleteLive(
  tx: DbExecutor,
  input: PartyRef & { domainId: string; actorUserId: string }
): Promise<{ id: string; domain: string; source: PartyDomainSource } | undefined> {
  const [removed] = await tx
    .update(partyDomains)
    .set({ deletedAt: new Date(), deletedByUserId: input.actorUserId })
    .where(
      and(
        eq(partyDomains.id, input.domainId),
        eq(partyDomains.partyType, input.partyType),
        eq(partyDomains.partyId, input.partyId),
        isNull(partyDomains.deletedAt)
      )
    )
    .returning({
      id: partyDomains.id,
      domain: partyDomains.domain,
      source: partyDomains.source,
    });
  return removed;
}

async function selectLiveOwner(
  tx: DbExecutor,
  domain: string
): Promise<{ id: string; partyType: PartyType; partyId: string } | undefined> {
  const [owner] = await tx
    .select({
      id: partyDomains.id,
      partyType: partyDomains.partyType,
      partyId: partyDomains.partyId,
    })
    .from(partyDomains)
    .where(and(eq(partyDomains.domain, domain), isNull(partyDomains.deletedAt)))
    .limit(1);
  return owner;
}

function auditMetadata(
  ref: PartyRef,
  row: { domain: string; reason: string },
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    partyType: ref.partyType,
    partyId: ref.partyId,
    domain: row.domain,
    source: 'admin_added' satisfies PartyDomainSource,
    reason: row.reason,
    ...extra,
  };
}

async function countMembers(ref: PartyRef): Promise<number> {
  const [row] =
    ref.partyType === 'company'
      ? await db
          .select({ total: count() })
          .from(companyMembers)
          .where(and(eq(companyMembers.companyId, ref.partyId), isNull(companyMembers.deletedAt)))
      : await db
          .select({ total: count() })
          .from(agencyMembers)
          .where(and(eq(agencyMembers.agencyId, ref.partyId), isNull(agencyMembers.deletedAt)));
  return row?.total ?? 0;
}

// ── Repository ────────────────────────────────────────────────────────────────────────

/**
 * Balo-staff domain writes (BAL-594). `@balo/db` never checks roles — the web layer
 * gates on `MANAGE_PARTY_DOMAINS` before calling anything here. Every write is one
 * transaction carrying its audit row, returns a typed outcome, and never catches a
 * raw unique violation: the partial-unique index is the backstop, reached through
 * `ON CONFLICT DO NOTHING` and conditional updates.
 */
export const partyDomainsStaffRepository = {
  addDomain: async (input: StaffAddDomainInput): Promise<StaffAddDomainResult> => {
    return db.transaction(async (tx): Promise<StaffAddDomainResult> => {
      const domain = normalizeDomain(input.domain);
      if (domain === '') return { outcome: 'not_applicable' };
      if (isBlockedDomain(domain)) return { outcome: 'blocked_domain' };

      const target = await assertTargetParty(tx, input);
      if (target !== 'ok') return { outcome: target };

      const domainId = await insertLive(tx, {
        partyType: input.partyType,
        partyId: input.partyId,
        domain,
        actorUserId: input.actorUserId,
      });

      if (domainId === undefined) {
        const owner = await selectLiveOwner(tx, domain);
        if (owner === undefined) return { outcome: 'conflict_retry' };
        if (owner.partyType === input.partyType && owner.partyId === input.partyId) {
          return { outcome: 'already_on_party' };
        }
        return {
          outcome: 'owned_by_other',
          ownerDomainId: owner.id,
          ownerPartyType: owner.partyType,
          ownerPartyId: owner.partyId,
        };
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: PARTY_DOMAIN_STAFF_AUDIT.ADDED,
          entityType: 'party_domain',
          entityId: domainId,
          metadata: auditMetadata(input, { domain, reason: input.reason }),
        },
        tx
      );
      return { outcome: 'added', domainId, domain };
    });
  },

  removeDomain: async (input: StaffRemoveDomainInput): Promise<StaffRemoveDomainResult> => {
    return db.transaction(async (tx): Promise<StaffRemoveDomainResult> => {
      const removed = await softDeleteLive(tx, input);
      if (removed === undefined) return { outcome: 'not_found' };

      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: PARTY_DOMAIN_STAFF_AUDIT.REMOVED,
          entityType: 'party_domain',
          entityId: removed.id,
          metadata: {
            ...auditMetadata(input, { domain: removed.domain, reason: input.reason }),
            source: removed.source,
          },
        },
        tx
      );
      return { outcome: 'removed', domain: removed.domain, source: removed.source };
    });
  },

  /**
   * Moves a live domain to another party: soft-delete the expected owner's row, insert
   * the new owner's row, write both audit rows — one transaction. A row that is no
   * longer live or no longer owned by `expected` matches zero rows and yields `stale`
   * with nothing written, which is also what a concurrent second reassign sees.
   */
  reassignDomain: async (input: StaffReassignDomainInput): Promise<StaffReassignDomainResult> => {
    const { expected, to } = input;
    if (to.partyType === expected.partyType && to.partyId === expected.partyId) {
      return { outcome: 'same_party' };
    }

    try {
      return await db.transaction(async (tx): Promise<StaffReassignDomainResult> => {
        const target = await assertTargetParty(tx, to);
        if (target !== 'ok') return { outcome: target };

        const removed = await softDeleteLive(tx, {
          domainId: expected.domainId,
          partyType: expected.partyType,
          partyId: expected.partyId,
          actorUserId: input.actorUserId,
        });
        if (removed === undefined) return { outcome: 'stale' };

        const addedDomainId = await insertLive(tx, {
          partyType: to.partyType,
          partyId: to.partyId,
          domain: removed.domain,
          actorUserId: input.actorUserId,
        });
        if (addedDomainId === undefined) throw new ReassignInsertLostError();

        await auditEventsRepository.record(
          {
            actorUserId: input.actorUserId,
            action: PARTY_DOMAIN_STAFF_AUDIT.REMOVED,
            entityType: 'party_domain',
            entityId: removed.id,
            metadata: {
              ...auditMetadata(expected, { domain: removed.domain, reason: input.reason }),
              source: removed.source,
              reassignedTo: { partyType: to.partyType, partyId: to.partyId },
            },
          },
          tx
        );
        await auditEventsRepository.record(
          {
            actorUserId: input.actorUserId,
            action: PARTY_DOMAIN_STAFF_AUDIT.ADDED,
            entityType: 'party_domain',
            entityId: addedDomainId,
            metadata: auditMetadata(
              to,
              { domain: removed.domain, reason: input.reason },
              { reassignedFrom: { partyType: expected.partyType, partyId: expected.partyId } }
            ),
          },
          tx
        );

        return {
          outcome: 'reassigned',
          removedDomainId: removed.id,
          addedDomainId,
          domain: removed.domain,
          removedSource: removed.source,
        };
      });
    } catch (error) {
      if (error instanceof ReassignInsertLostError) return { outcome: 'conflict_retry' };
      throw error;
    }
  },

  /** The party header for the staff page, or `undefined` when it does not exist. */
  getPartyForStaff: async (
    partyType: PartyType,
    partyId: string
  ): Promise<StaffPartySummary | undefined> => {
    if (partyType === 'company') {
      const [company] = await db
        .select({ name: companies.name, isPersonal: companies.isPersonal })
        .from(companies)
        .where(eq(companies.id, partyId))
        .limit(1);
      if (company === undefined) return undefined;
      return {
        partyType,
        partyId,
        name: company.name,
        isPersonal: company.isPersonal,
        memberCount: await countMembers({ partyType, partyId }),
      };
    }
    const [agency] = await db
      .select({ name: agencies.name })
      .from(agencies)
      .where(eq(agencies.id, partyId))
      .limit(1);
    if (agency === undefined) return undefined;
    return {
      partyType,
      partyId,
      name: agency.name,
      isPersonal: false,
      memberCount: await countMembers({ partyType, partyId }),
    };
  },

  /** Live domains for a party with full creator identity and the staff reason, oldest first. */
  listForStaff: async (partyType: PartyType, partyId: string): Promise<StaffPartyDomainRow[]> => {
    const rows = await db
      .select({
        id: partyDomains.id,
        domain: partyDomains.domain,
        source: partyDomains.source,
        createdAt: partyDomains.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
        hasCreator: users.id,
        auditId: auditEvents.id,
        reason: sql<string | null>`${auditEvents.metadata}->>'reason'`,
      })
      .from(partyDomains)
      .leftJoin(users, eq(users.id, partyDomains.createdByUserId))
      .leftJoin(
        auditEvents,
        and(
          eq(auditEvents.entityType, 'party_domain'),
          eq(auditEvents.entityId, partyDomains.id),
          eq(auditEvents.action, PARTY_DOMAIN_STAFF_AUDIT.ADDED)
        )
      )
      .where(
        and(
          eq(partyDomains.partyType, partyType),
          eq(partyDomains.partyId, partyId),
          isNull(partyDomains.deletedAt)
        )
      )
      .orderBy(asc(partyDomains.createdAt), asc(partyDomains.id));

    return rows.map((row): StaffPartyDomainRow => {
      let addedVia: StaffDomainAddedVia = 'signup';
      if (row.source === 'admin_added') {
        addedVia = row.auditId === null ? 'party_admin' : 'balo';
      }
      return {
        id: row.id,
        domain: row.domain,
        source: row.source,
        createdAt: row.createdAt,
        createdBy:
          row.hasCreator === null ? null : { firstName: row.firstName, lastName: row.lastName },
        addedVia,
        reason: row.reason,
      };
    });
  },

  /** The single live owner of a domain platform-wide, with the owning party's header. */
  findLiveOwnerForStaff: async (domain: string): Promise<StaffDomainOwner | undefined> => {
    const normalized = normalizeDomain(domain);
    if (normalized === '') return undefined;

    const [row] = await db
      .select({
        id: partyDomains.id,
        domain: partyDomains.domain,
        partyType: partyDomains.partyType,
        partyId: partyDomains.partyId,
        source: partyDomains.source,
        createdAt: partyDomains.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
        hasCreator: users.id,
      })
      .from(partyDomains)
      .leftJoin(users, eq(users.id, partyDomains.createdByUserId))
      .where(and(eq(partyDomains.domain, normalized), isNull(partyDomains.deletedAt)))
      .limit(1);
    if (row === undefined) return undefined;

    const party = await partyDomainsStaffRepository.getPartyForStaff(row.partyType, row.partyId);
    if (party === undefined) return undefined;

    return {
      domainId: row.id,
      domain: row.domain,
      partyType: row.partyType,
      partyId: row.partyId,
      partyName: party.name,
      memberCount: party.memberCount,
      source: row.source,
      createdAt: row.createdAt,
      createdBy:
        row.hasCreator === null ? null : { firstName: row.firstName, lastName: row.lastName },
    };
  },
};
