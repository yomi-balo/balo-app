import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { proposalShareLinks, type ProposalShareLink } from '../schema';
import { auditEventsRepository } from './audit-events';

const ENTITY_TYPE = 'proposal_share_link';

export interface CreateShareLinkInput {
  relationshipId: string;
  /** Stored as-is — the CALLER lowercases (mirrors expert_referral_invites). */
  recipientEmail: string;
  /** SHA-256 hex of the raw token; the raw token is NEVER passed here or persisted. */
  tokenHash: string;
  note: string | null;
  createdByUserId: string;
  /** Optional explicit expiry; DB default (now() + 30 days) applies when omitted. */
  expiresAt?: Date;
}

export interface CreateShareLinkResult {
  link: ProposalShareLink;
  /** The prior LIVE link that was revoked to vacate the unique slot, if any. */
  revokedPriorId: string | null;
}

export interface RevokeShareLinkInput {
  id: string;
  actorUserId: string;
}

export const proposalShareLinksRepository = {
  /**
   * Mint a share link for (relationship, recipient). In ONE transaction: revoke any
   * prior LIVE link for the same (relationship, lower(recipient)) — which vacates the
   * partial-unique slot BEFORE the insert so there is no collision (mirrors the
   * proposals resubmit pattern) — audit that supersession, insert the new link, and
   * audit the creation. Both audit rows commit or roll back with the link.
   */
  create: async (input: CreateShareLinkInput): Promise<CreateShareLinkResult> => {
    return db.transaction(async (tx) => {
      // a. Revoke the prior LIVE link (if any), vacating the partial-unique slot.
      const [prior] = await tx
        .update(proposalShareLinks)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: input.createdByUserId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(proposalShareLinks.relationshipId, input.relationshipId),
            sql`lower(${proposalShareLinks.recipientEmail}) = lower(${input.recipientEmail})`,
            isNull(proposalShareLinks.deletedAt),
            isNull(proposalShareLinks.revokedAt)
          )
        )
        .returning({ id: proposalShareLinks.id });

      const revokedPriorId = prior?.id ?? null;

      // b. Audit the supersession of the prior live link.
      if (revokedPriorId !== null) {
        await auditEventsRepository.record(
          {
            actorUserId: input.createdByUserId,
            action: 'proposal_share_link.revoked',
            entityType: ENTITY_TYPE,
            entityId: revokedPriorId,
            metadata: { relationshipId: input.relationshipId, reason: 'superseded_by_reshare' },
          },
          tx
        );
      }

      // c. Insert the new link.
      const [link] = await tx
        .insert(proposalShareLinks)
        .values({
          relationshipId: input.relationshipId,
          recipientEmail: input.recipientEmail,
          tokenHash: input.tokenHash,
          note: input.note,
          createdByUserId: input.createdByUserId,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        })
        .returning();
      if (link === undefined) {
        throw new Error('proposal_share_links insert returned no row');
      }

      // d. Audit the creation.
      await auditEventsRepository.record(
        {
          actorUserId: input.createdByUserId,
          action: 'proposal_share_link.created',
          entityType: ENTITY_TYPE,
          entityId: link.id,
          metadata: {
            relationshipId: input.relationshipId,
            recipientEmail: input.recipientEmail,
          },
        },
        tx
      );

      return { link, revokedPriorId };
    });
  },

  /**
   * Resolve a link by its token hash — but ONLY if it is currently usable: live
   * (not soft-deleted), not revoked, and not past its expiry. Rides the unique
   * `proposal_share_link_token_hash_idx`. Returns undefined for a wrong / revoked /
   * expired / deleted token (the caller cannot distinguish the reasons — by design).
   */
  findLiveByTokenHash: async (tokenHash: string): Promise<ProposalShareLink | undefined> => {
    const [row] = await db
      .select()
      .from(proposalShareLinks)
      .where(
        and(
          eq(proposalShareLinks.tokenHash, tokenHash),
          isNull(proposalShareLinks.deletedAt),
          isNull(proposalShareLinks.revokedAt),
          gt(proposalShareLinks.expiresAt, sql`now()`)
        )
      );
    return row;
  },

  /**
   * Stamp an access: bump `access_count` and set `last_accessed_at`. Runs through
   * Drizzle so the `updated_at` $onUpdate also fires; `updated_at` is set explicitly
   * too for parity with the other mutating methods.
   */
  recordAccess: async (id: string): Promise<void> => {
    await db
      .update(proposalShareLinks)
      .set({
        lastAccessedAt: sql`now()`,
        accessCount: sql`${proposalShareLinks.accessCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(proposalShareLinks.id, id));
  },

  /**
   * List the LIVE (not revoked, not soft-deleted) links for a relationship, newest
   * first — powers the sharer's "who has access" list.
   */
  listActiveByRelationship: async (relationshipId: string): Promise<ProposalShareLink[]> => {
    return db
      .select()
      .from(proposalShareLinks)
      .where(
        and(
          eq(proposalShareLinks.relationshipId, relationshipId),
          isNull(proposalShareLinks.deletedAt),
          isNull(proposalShareLinks.revokedAt)
        )
      )
      .orderBy(desc(proposalShareLinks.createdAt));
  },

  /**
   * Manually revoke a live link. In ONE transaction: flip revoked_at/revoked_by (only
   * if still live), and — when a row was actually revoked — audit it. Returns the
   * revoked row, or undefined when the link was missing / already revoked / deleted
   * (idempotent no-op → no audit row).
   */
  revoke: async (input: RevokeShareLinkInput): Promise<ProposalShareLink | undefined> => {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(proposalShareLinks)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: input.actorUserId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(proposalShareLinks.id, input.id),
            isNull(proposalShareLinks.deletedAt),
            isNull(proposalShareLinks.revokedAt)
          )
        )
        .returning();

      if (row === undefined) {
        return undefined;
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'proposal_share_link.revoked',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          metadata: { relationshipId: row.relationshipId, reason: 'manual' },
        },
        tx
      );

      return row;
    });
  },
};
