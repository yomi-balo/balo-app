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
};
