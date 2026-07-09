import { and, asc, eq, isNull } from 'drizzle-orm';
import { isBlockedDomain, normalizeDomain } from '@balo/shared/domains';
import { db } from '../client';
import { partyDomains, type PartyDomain, type PartyType, type PartyDomainSource } from '../schema';
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
  source?: PartyDomainSource; // defaults to 'auto_captured'
}

/** Input for the admin add-domain path (BAL-347). Source is forced to 'admin_added'. */
export interface AddDomainInput {
  partyType: PartyType;
  partyId: string;
  domain: string;
  actorUserId: string;
}

/** Input for the admin soft-remove path (BAL-347). Party-scoped by design. */
export interface RemoveDomainInput {
  domainId: string;
  partyType: PartyType;
  partyId: string;
  actorUserId: string;
}

/** Outcome of a party-scoped soft-remove — idempotent-safe (`not_found` on a miss). */
export type RemoveDomainResult = { outcome: 'removed'; domain: string } | { outcome: 'not_found' };

/**
 * A live domain row hydrated with its creator's NAME ONLY — a client-bound DTO for
 * the BAL-347 admin settings surface. Deliberately projects `id/firstName/lastName`
 * off the creator (NEVER `email`/`workosId`/PII) so the drizzle relational-`with`
 * PII-leak footgun cannot reach the browser.
 */
export interface PartyDomainWithCreator {
  id: string;
  domain: string;
  source: PartyDomainSource;
  createdAt: Date;
  createdBy: { id: string; firstName: string | null; lastName: string | null } | null;
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

    const source: PartyDomainSource = input.source ?? 'auto_captured';

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
    // to label this 'already_claimed' even though the slot is momentarily free. This
    // is a cosmetic mislabel, not a failure — harmless in v1 because nothing consumes
    // the label. BAL-345's matcher must NOT treat 'already_claimed' as authoritative
    // ownership. Deliberately no retry here (comment only).
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
   * Admin add-domain (BAL-347) — a thin self-wrapping wrapper over `capture()` that
   * FORCES `source: 'admin_added'`. Reuses capture's full outcome union (captured /
   * already_owned / skipped:blocked_domain|already_claimed / not_applicable) and its
   * single audit write (`party_domain.captured`, the `source` disambiguates the
   * admin path). Self-wraps `db.transaction` so the mapping + audit commit together;
   * `capture` itself never throws on the conflict path.
   */
  addDomain: async (input: AddDomainInput): Promise<DomainCaptureResult> => {
    return db.transaction((tx) =>
      partyDomainsRepository.capture(
        {
          partyType: input.partyType,
          partyId: input.partyId,
          domain: input.domain,
          actorUserId: input.actorUserId,
          source: 'admin_added',
        },
        tx
      )
    );
  },

  /**
   * Admin soft-remove of a domain (BAL-347) — party-scoped defence-in-depth: the
   * WHERE matches `id AND party_type AND party_id AND deleted_at IS NULL`, so a
   * caller can never remove a domain that belongs to a DIFFERENT party by guessing
   * its id. Stamps `deleted_at`/`deleted_by_user_id`, writes the
   * `party_domain.removed` audit row in the SAME tx, and returns `not_found`
   * (idempotent-safe) when nothing matched. The soft-delete frees the partial-unique
   * slot for a later re-capture (the index is partial on `deleted_at IS NULL`).
   */
  removeDomain: async (input: RemoveDomainInput): Promise<RemoveDomainResult> => {
    return db.transaction(async (tx) => {
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

      if (removed === undefined) {
        return { outcome: 'not_found' };
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'party_domain.removed',
          entityType: 'party_domain',
          entityId: removed.id,
          metadata: {
            partyType: input.partyType,
            partyId: input.partyId,
            domain: removed.domain,
            source: removed.source,
          },
        },
        tx
      );

      return { outcome: 'removed', domain: removed.domain };
    });
  },

  /**
   * Live domains for a party hydrated with creator NAME (BAL-347 admin surface),
   * oldest-first. Uses a PROJECTED relational `with` (`id/firstName/lastName` only)
   * so the full creator row — with `email`/`workosId`/PII — is never hydrated into a
   * client-bound DTO (the relational-`with` PII-leak footgun). Excludes soft-deleted.
   */
  listByPartyWithCreator: async (
    partyType: PartyType,
    partyId: string
  ): Promise<PartyDomainWithCreator[]> => {
    const rows = await db.query.partyDomains.findMany({
      where: and(
        eq(partyDomains.partyType, partyType),
        eq(partyDomains.partyId, partyId),
        isNull(partyDomains.deletedAt)
      ),
      with: {
        createdByUser: {
          columns: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: (fields, { asc: ascOrder }) => [ascOrder(fields.createdAt)],
    });

    return rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      source: row.source,
      createdAt: row.createdAt,
      createdBy:
        row.createdByUser === null || row.createdByUser === undefined
          ? null
          : {
              id: row.createdByUser.id,
              firstName: row.createdByUser.firstName,
              lastName: row.createdByUser.lastName,
            },
    }));
  },
};
