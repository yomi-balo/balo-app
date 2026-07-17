import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rolesWithCapability, CAPABILITIES } from '@balo/shared/authz';
import { db } from '../client';
import {
  companies,
  agencies,
  companyMembers,
  agencyMembers,
  type PartyType,
  type Company,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';
import { usersRepository } from './users';

/**
 * party-memberships (BAL-345) — the membership-creation/removal helper that
 * handles BOTH company_members and agency_members by `partyType`. `@balo/db`
 * NEVER emits analytics/notifications — the `apps/web` caller maps the structured
 * result to PostHog / the notification engine AFTER the transaction commits.
 *
 * Duplication (Sonar >3% new-code gate): the ONLY table-specific code is the five
 * small private query helpers below, which branch once on `partyType`. Because the
 * company/agency branches use DIFFERENT identifiers (companyMembers/companyId vs
 * agencyMembers/agencyId) they are not token-identical clones. All shared
 * orchestration (audit write, outcome mapping) is written ONCE in the public
 * methods.
 */

type DomainJoinMode = Company['domainJoinMode'];
type MembershipAuthority = Company['membershipAuthority'];

/** Per-party constants: the audit entity type + the base (non-admin) role. */
const PARTY_MEMBERSHIP: Record<
  PartyType,
  { entityType: 'company_member' | 'agency_member'; baseRole: 'member' | 'expert' }
> = {
  company: { entityType: 'company_member', baseRole: 'member' },
  agency: { entityType: 'agency_member', baseRole: 'expert' },
};

export interface DomainMembershipInput {
  partyType: PartyType;
  partyId: string;
  userId: string;
  /** The actor recorded on the audit row (the joining/removing user in v1). */
  actorUserId: string;
}

export type FindOrCreateMembershipResult =
  | { outcome: 'joined'; membershipId: string }
  | { outcome: 'already_member'; membershipId: string };

export type SoftRemoveMembershipResult = { outcome: 'removed' } | { outcome: 'not_found' };

export interface PartyJoinSettings {
  domainJoinMode: DomainJoinMode;
  membershipAuthority: MembershipAuthority;
  /** `companies.isPersonal` for a company; always `false` for an agency. */
  isPersonal: boolean;
}

// ── Table-specific query primitives (the ONLY partyType branches) ─────────

/**
 * INSERT a `domain_match` membership, ON CONFLICT DO NOTHING against the partial
 * live-unique arbiter `(party_id, user_id) WHERE deleted_at IS NULL` — the
 * predicate MUST match the §1.3 index verbatim. Returns the new row id, or
 * `undefined` when a live membership already exists (conflict).
 */
async function insertDomainMatchRow(
  exec: DbExecutor,
  partyType: PartyType,
  partyId: string,
  userId: string
): Promise<string | undefined> {
  if (partyType === 'company') {
    const [row] = await exec
      .insert(companyMembers)
      .values({ companyId: partyId, userId, role: 'member', joinMethod: 'domain_match' })
      .onConflictDoNothing({
        target: [companyMembers.companyId, companyMembers.userId],
        where: isNull(companyMembers.deletedAt),
      })
      .returning({ id: companyMembers.id });
    return row?.id;
  }
  const [row] = await exec
    .insert(agencyMembers)
    .values({ agencyId: partyId, userId, role: 'expert', joinMethod: 'domain_match' })
    .onConflictDoNothing({
      target: [agencyMembers.agencyId, agencyMembers.userId],
      where: isNull(agencyMembers.deletedAt),
    })
    .returning({ id: agencyMembers.id });
  return row?.id;
}

/** The single LIVE membership id for (party, user), or undefined. */
async function selectLiveMembershipId(
  exec: DbExecutor,
  partyType: PartyType,
  partyId: string,
  userId: string
): Promise<string | undefined> {
  if (partyType === 'company') {
    const [row] = await exec
      .select({ id: companyMembers.id })
      .from(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, partyId),
          eq(companyMembers.userId, userId),
          isNull(companyMembers.deletedAt)
        )
      )
      .limit(1);
    return row?.id;
  }
  const [row] = await exec
    .select({ id: agencyMembers.id })
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, partyId),
        eq(agencyMembers.userId, userId),
        isNull(agencyMembers.deletedAt)
      )
    )
    .limit(1);
  return row?.id;
}

/**
 * Soft-remove ONLY the live `domain_match` membership for (party, user) — never a
 * personal_workspace / invite / owner membership. Returns the removed row id, or
 * undefined when there is no live domain_match membership.
 */
async function softRemoveDomainMatchRow(
  exec: DbExecutor,
  partyType: PartyType,
  partyId: string,
  userId: string,
  actorUserId: string
): Promise<string | undefined> {
  if (partyType === 'company') {
    const [row] = await exec
      .update(companyMembers)
      .set({ deletedAt: new Date(), deletedByUserId: actorUserId })
      .where(
        and(
          eq(companyMembers.companyId, partyId),
          eq(companyMembers.userId, userId),
          isNull(companyMembers.deletedAt),
          eq(companyMembers.joinMethod, 'domain_match')
        )
      )
      .returning({ id: companyMembers.id });
    return row?.id;
  }
  const [row] = await exec
    .update(agencyMembers)
    .set({ deletedAt: new Date(), deletedByUserId: actorUserId })
    .where(
      and(
        eq(agencyMembers.agencyId, partyId),
        eq(agencyMembers.userId, userId),
        isNull(agencyMembers.deletedAt),
        eq(agencyMembers.joinMethod, 'domain_match')
      )
    )
    .returning({ id: agencyMembers.id });
  return row?.id;
}

/** The live role for (party, user) as a plain string, or undefined. */
async function selectLiveRole(
  partyType: PartyType,
  partyId: string,
  userId: string
): Promise<string | undefined> {
  if (partyType === 'company') {
    const [row] = await db
      .select({ role: companyMembers.role })
      .from(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, partyId),
          eq(companyMembers.userId, userId),
          isNull(companyMembers.deletedAt)
        )
      )
      .limit(1);
    return row?.role;
  }
  const [row] = await db
    .select({ role: agencyMembers.role })
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, partyId),
        eq(agencyMembers.userId, userId),
        isNull(agencyMembers.deletedAt)
      )
    )
    .limit(1);
  return row?.role;
}

/** Live member user ids whose role is in `adminRoles`. */
async function selectAdminUserIds(
  partyType: PartyType,
  partyId: string,
  adminRoles: string[]
): Promise<string[]> {
  if (adminRoles.length === 0) return [];
  if (partyType === 'company') {
    const rows = await db
      .select({ userId: companyMembers.userId })
      .from(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, partyId),
          inArray(sql`${companyMembers.role}`, adminRoles),
          isNull(companyMembers.deletedAt)
        )
      );
    return rows.map((r) => r.userId);
  }
  const rows = await db
    .select({ userId: agencyMembers.userId })
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, partyId),
        inArray(sql`${agencyMembers.role}`, adminRoles),
        isNull(agencyMembers.deletedAt)
      )
    );
  return rows.map((r) => r.userId);
}

/** Live company member user ids whose role grants MANAGE_BILLING (the wallet billing admins). */
async function selectBillingUserIds(companyId: string): Promise<string[]> {
  return selectAdminUserIds('company', companyId, rolesWithCapability(CAPABILITIES.MANAGE_BILLING));
}

async function selectPartyJoinSettings(
  partyType: PartyType,
  partyId: string
): Promise<PartyJoinSettings | undefined> {
  if (partyType === 'company') {
    const [row] = await db
      .select({
        domainJoinMode: companies.domainJoinMode,
        membershipAuthority: companies.membershipAuthority,
        isPersonal: companies.isPersonal,
      })
      .from(companies)
      .where(eq(companies.id, partyId))
      .limit(1);
    return row;
  }
  const [row] = await db
    .select({
      domainJoinMode: agencies.domainJoinMode,
      membershipAuthority: agencies.membershipAuthority,
    })
    .from(agencies)
    .where(eq(agencies.id, partyId))
    .limit(1);
  // Agencies have no `isPersonal` column — they are never personal.
  return row === undefined ? undefined : { ...row, isPersonal: false };
}

// ── Public repository ─────────────────────────────────────────────────────

export const partyMembershipsRepository = {
  /**
   * The owning party's join settings, plus `isPersonal` (company only; false for
   * agency). Returns `undefined` when the party row is absent — the match engine
   * MUST guard this and treat it as `no_match`.
   */
  getPartyJoinSettings: async (
    partyType: PartyType,
    partyId: string
  ): Promise<PartyJoinSettings | undefined> => {
    return selectPartyJoinSettings(partyType, partyId);
  },

  /**
   * Idempotent find-or-create of a `domain_match` membership (base role: company →
   * `member`, agency → `expert`). Runs in the caller's tx when `exec` is supplied,
   * else self-wraps. `INSERT ... ON CONFLICT DO NOTHING` on the partial live-unique
   * arbiter: a returned row → audit `party_membership.domain_joined` → `joined`;
   * a conflict → re-SELECT the live membership → `already_member` (no double
   * audit). Mirrors `partyDomainsRepository.capture`.
   */
  findOrCreateDomainMembership: async (
    input: DomainMembershipInput,
    exec?: DbExecutor
  ): Promise<FindOrCreateMembershipResult> => {
    const run = async (tx: DbExecutor): Promise<FindOrCreateMembershipResult> => {
      const { entityType } = PARTY_MEMBERSHIP[input.partyType];
      const insertedId = await insertDomainMatchRow(
        tx,
        input.partyType,
        input.partyId,
        input.userId
      );
      if (insertedId !== undefined) {
        await auditEventsRepository.record(
          {
            actorUserId: input.actorUserId,
            action: 'party_membership.domain_joined',
            entityType,
            entityId: insertedId,
            metadata: {
              partyType: input.partyType,
              partyId: input.partyId,
              userId: input.userId,
              joinMethod: 'domain_match',
            },
          },
          tx
        );
        return { outcome: 'joined', membershipId: insertedId };
      }
      // Conflict — a live membership already exists (any join_method). Resolve it.
      const existingId = await selectLiveMembershipId(
        tx,
        input.partyType,
        input.partyId,
        input.userId
      );
      if (existingId === undefined) {
        throw new Error('findOrCreateDomainMembership: conflict but no live membership found');
      }
      return { outcome: 'already_member', membershipId: existingId };
    };
    return exec ? run(exec) : db.transaction(run);
  },

  /**
   * Escape-hatch removal: soft-delete the live `domain_match` membership only
   * (never personal_workspace / invite / owner), stamping `deletedAt` +
   * `deletedByUserId`, then audit `party_membership.domain_removed`. Idempotent —
   * `not_found` when there is nothing to remove.
   *
   * NOTE: `domain_match` is written by BOTH auto-join AND approved-request
   * materialisation, so this also removes an approved-request membership. In v1
   * that is the intended "get me out of this party regardless of how I joined"
   * semantics; the reported opt-out `path` is derived by the orchestrator (§2.6),
   * not from join_method.
   */
  softRemoveDomainMembership: async (
    input: DomainMembershipInput,
    exec?: DbExecutor
  ): Promise<SoftRemoveMembershipResult> => {
    const run = async (tx: DbExecutor): Promise<SoftRemoveMembershipResult> => {
      const { entityType } = PARTY_MEMBERSHIP[input.partyType];
      const removedId = await softRemoveDomainMatchRow(
        tx,
        input.partyType,
        input.partyId,
        input.userId,
        input.actorUserId
      );
      if (removedId === undefined) return { outcome: 'not_found' };
      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'party_membership.domain_removed',
          entityType,
          entityId: removedId,
          metadata: {
            partyType: input.partyType,
            partyId: input.partyId,
            userId: input.userId,
            joinMethod: 'domain_match',
          },
        },
        tx
      );
      return { outcome: 'removed' };
    };
    return exec ? run(exec) : db.transaction(run);
  },

  /**
   * The authz seam's single live-role lookup. MUST filter `isNull(deletedAt)` —
   * the composite unique is partial on live rows, so "≤1 live membership per
   * (party, user)" only holds when soft-removed rows are excluded. Without it a
   * soft-removed (escape-hatch'd) admin membership would still return its role and
   * pass the MANAGE_MEMBERS gate. Load-bearing.
   */
  getMemberRole: async (
    partyType: PartyType,
    partyId: string,
    userId: string
  ): Promise<string | undefined> => {
    return selectLiveRole(partyType, partyId, userId);
  },

  /**
   * Live member user ids whose role grants `MANAGE_MEMBERS` — for notification
   * recipient fan-out (party admins). The admin-role set is derived from the pure
   * `@balo/shared/authz` map (NOT hardcoded `role IN ('owner','admin')`), keeping
   * the role→capability map the single place a role is interpreted.
   */
  listAdminUserIds: async (partyType: PartyType, partyId: string): Promise<string[]> => {
    const adminRoles = rolesWithCapability(CAPABILITIES.MANAGE_MEMBERS);
    return selectAdminUserIds(partyType, partyId, adminRoles);
  },

  /**
   * Live company member user ids whose role grants `MANAGE_BILLING` (owner/admin) — the
   * notification fan-out for credit dormancy-reminder / balance-expired notices (BAL-380).
   * Company-only: wallets are one-per-company. The billing-role set is derived from the
   * pure `@balo/shared/authz` map (NOT a hardcoded `role IN ('owner','admin')`), so the
   * role→capability map stays the single place a role is interpreted; `selectAdminUserIds`
   * filters `isNull(deletedAt)`, so a soft-removed owner/admin is excluded. A company with
   * zero owner/admin → `[]` → the dispatcher skips the fan-out.
   */
  listBillingUserIds: async (companyId: string): Promise<string[]> => {
    return selectBillingUserIds(companyId);
  },

  /**
   * Best-effort display name of a company's FIRST billing admin (MANAGE_BILLING holder) —
   * the "Ask {name} to top up" copy in the member-lens drawdown notice (BAL-378). The single
   * home for both the apps/api service (`getSessionDrawdownState`) and the apps/web read
   * action, so the resolution never drifts (Sonar new-code duplication gate). Returns
   * `undefined` when the company has no billing admin or the admin has no set name.
   */
  resolveBillingAdminName: async (companyId: string): Promise<string | undefined> => {
    const [adminUserId] = await selectBillingUserIds(companyId);
    if (adminUserId === undefined) {
      return undefined;
    }
    const user = await usersRepository.findById(adminUserId);
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
    return name.length > 0 ? name : undefined;
  },
};
