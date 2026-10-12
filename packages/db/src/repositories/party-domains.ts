import { and, asc, eq, isNull } from 'drizzle-orm';
import { isBlockedDomain, normalizeDomain } from '@balo/shared/domains';
import { db } from '../client';
import {
  partyDomains,
  users,
  type PartyDomain,
  type PartyType,
  type PartyDomainSource,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';

/**
 * Structured outcome of a capture attempt. `@balo/db` NEVER emits analytics — the
 * `apps/web` caller maps this result to PostHog AFTER the transaction commits.
 */
export type DomainCaptureResult =
  | { outcome: 'captured'; partyType: PartyType; source: PartyDomainSource }
  | { outcome: 'already_owned' } // idempotent no-op — same party already owns it
  | { outcome: 'skipped'; reason: 'blocked_domain' | 'already_claimed' }
  | { outcome: 'not_applicable' }; // no capturable domain supplied

export interface CaptureDomainInput {
  partyType: PartyType;
  partyId: string;
  domain: string; // caller-extracted; the repo re-normalises defensively
  actorUserId: string;
}

/** How a domain reached a party, as customers may see it — never carries staff identity. */
export type PartyDomainAttribution = { kind: 'signup'; name: string | null } | { kind: 'balo' };

/** A live domain row projected for the party-side read-only settings surfaces. */
export interface PartyDomainForSettings {
  id: string;
  domain: string;
  createdAt: Date;
  attribution: PartyDomainAttribution;
}

export const partyDomainsRepository = {
  /**
   * Find-or-create the domain→party mapping. Idempotent and race-safe:
   *  - blocked (freemail/disposable) → `skipped: blocked_domain` (no write)
   *  - `INSERT ... ON CONFLICT DO NOTHING` with the PARTIAL-unique predicate as the
   *    arbiter → if a row returns, WE won the slot → write the audit row → `captured`
   *  - no row returned (a live mapping already exists): SELECT the live owner →
   *      same party  → `already_owned` (idempotent retry — no double audit/emit)
   *      other party → `skipped: already_claimed`
   *
   * Never throws 23505 (`ON CONFLICT` swallows it) — satisfies "one winner, no 500"
   * even under two concurrent transactions (the loser BLOCKS on the unique index,
   * then DO NOTHING). Takes `exec` so the whole thing runs INSIDE the caller's
   * `db.transaction`; a genuine DB failure still propagates and rolls the tx back.
   */
  capture: async (input: CaptureDomainInput, exec: DbExecutor): Promise<DomainCaptureResult> => {
    const domain = normalizeDomain(input.domain);
    if (domain === '') return { outcome: 'not_applicable' };
    if (isBlockedDomain(domain)) return { outcome: 'skipped', reason: 'blocked_domain' };

    const source: PartyDomainSource = 'auto_captured';

    const [inserted] = await exec
      .insert(partyDomains)
      .values({
        partyType: input.partyType,
        partyId: input.partyId,
        domain,
        source,
        createdByUserId: input.actorUserId,
      })
      .onConflictDoNothing({
        target: partyDomains.domain, // arbiter = the PARTIAL unique index
        where: isNull(partyDomains.deletedAt), // predicate MUST match the index exactly
      })
      .returning();

    if (inserted !== undefined) {
      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'party_domain.captured',
          entityType: 'party_domain',
          entityId: inserted.id,
          metadata: { partyType: input.partyType, partyId: input.partyId, domain, source },
        },
        exec
      );
      return { outcome: 'captured', partyType: input.partyType, source };
    }

    // Conflict — a live mapping already owns this domain. Resolve the owner.
    const existing = await exec
      .select()
      .from(partyDomains)
      .where(and(eq(partyDomains.domain, domain), isNull(partyDomains.deletedAt)))
      .limit(1);
    const [owner] = existing;
    if (
      owner !== undefined &&
      owner.partyType === input.partyType &&
      owner.partyId === input.partyId
    ) {
      return { outcome: 'already_owned' };
    }
    // Owner-resolution race: if a concurrent soft-delete freed the slot between the
    // failed INSERT above and this SELECT, `owner` is undefined and we fall through
    // to label this 'already_claimed' even though the slot is momentarily free.
    // 'already_claimed' therefore means "we did not win the slot", NOT "another party
    // provably owns it" — consumers MUST re-resolve the owner instead of treating this
    // label as authoritative ownership. `companiesRepository.promoteToOrganization` does
    // exactly that, mapping the undefined-owner case to `domain_conflict_retryable`
    // (BAL-372). Deliberately no retry here (comment only).
    return { outcome: 'skipped', reason: 'already_claimed' };
  },

  /**
   * The single LIVE party that owns a domain platform-wide, or `undefined`. The
   * partial-unique index guarantees ≤1 live row per domain, so this is the
   * BAL-345 match engine's ownership lookup. Kept PURE (party_domains only) — it
   * does NOT join `companies.isPersonal` (party_domains is polymorphic; agencies
   * have no `isPersonal`). The isPersonal stand-down lives in
   * `getPartyJoinSettings` + the engine decision tree.
   */
  findActiveByDomain: async (domain: string): Promise<PartyDomain | undefined> => {
    const d = normalizeDomain(domain);
    if (d === '') return undefined;
    const [row] = await db
      .select()
      .from(partyDomains)
      .where(and(eq(partyDomains.domain, d), isNull(partyDomains.deletedAt)))
      .limit(1);
    return row;
  },

  /** All live domains for a party (reverse lookup — used by BAL-345), oldest first. */
  listByParty: async (partyType: PartyType, partyId: string): Promise<PartyDomain[]> => {
    return db
      .select()
      .from(partyDomains)
      .where(
        and(
          eq(partyDomains.partyType, partyType),
          eq(partyDomains.partyId, partyId),
          isNull(partyDomains.deletedAt)
        )
      )
      .orderBy(asc(partyDomains.createdAt));
  },

  /**
   * Live domains for a party's read-only settings surfaces, oldest-first. Projected
   * server-side so staff identity never reaches the browser: `auto_captured` rows carry
   * the capturing user's trimmed display name (or `null`); `admin_added` rows resolve to
   * `{ kind: 'balo' }` with no name key at all. `source` itself is not exported.
   */
  listForPartySettings: async (
    partyType: PartyType,
    partyId: string
  ): Promise<PartyDomainForSettings[]> => {
    const rows = await db
      .select({
        id: partyDomains.id,
        domain: partyDomains.domain,
        source: partyDomains.source,
        createdAt: partyDomains.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(partyDomains)
      .leftJoin(users, eq(users.id, partyDomains.createdByUserId))
      .where(
        and(
          eq(partyDomains.partyType, partyType),
          eq(partyDomains.partyId, partyId),
          isNull(partyDomains.deletedAt)
        )
      )
      .orderBy(asc(partyDomains.createdAt), asc(partyDomains.id));

    return rows.map((row): PartyDomainForSettings => {
      if (row.source === 'admin_added') {
        return {
          id: row.id,
          domain: row.domain,
          createdAt: row.createdAt,
          attribution: { kind: 'balo' },
        };
      }
      const name = [row.firstName, row.lastName]
        .map((part) => part?.trim() ?? '')
        .filter((part) => part !== '')
        .join(' ');
      return {
        id: row.id,
        domain: row.domain,
        createdAt: row.createdAt,
        attribution: { kind: 'signup', name: name === '' ? null : name },
      };
    });
  },
};
