import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { representations, type NewRepresentation } from '../schema';
import {
  representationFactory,
  userFactory,
  companyFactory,
  projectRequestFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  representationsRepository,
  RepresentationCapabilityError,
  RepresentationScopeError,
  RepresentationExpiryError,
  RepresentationConflictError,
} from './representations';

/**
 * BAL-313 / ADR-1028 Phase 1 — `representations` (act-on-behalf grant).
 *
 * ⚠ EVERY RAW CONSTRAINT PROBE GOES THROUGH `expectConstraintViolation`, WHICH RUNS IT ON
 * ITS OWN SAVEPOINT USING THE SUPPLIED `tx`. The harness holds each test inside ONE outer
 * transaction; a failing statement on the module-level `db` ABORTS it and every later
 * statement answers `25P02` instead of the SQLSTATE under assertion.
 *
 * REPOSITORY calls are different, and deliberately so: `grant()` wraps its own body in
 * `exec.transaction(…)`, which is a SAVEPOINT when the executor is already a transaction —
 * so an expected `23505` inside `grant()` is CONTAINED and the test can keep asserting
 * afterwards. Test 15 (idempotency) proves exactly that by running a further query in the
 * same test after the second `grant()` call.
 *
 * ⚠ Concurrency is INEXPRESSIBLE under this harness (`max:1` pool, one transaction per
 * test) — no test here attempts it.
 */

const MINUTE_MS = 60_000;

interface ActorCompanySeed {
  actorUserId: string;
  grantedByUserId: string;
  companyId: string;
}

interface RequestGrainSeed extends ActorCompanySeed {
  projectRequestId: string;
}

/** A bare actor + granter + company, with NO representation seeded yet. */
async function seedActorAndCompany(): Promise<ActorCompanySeed> {
  const actor = await userFactory();
  const granter = await userFactory();
  const company = await companyFactory();
  return { actorUserId: actor.id, grantedByUserId: granter.id, companyId: company.id };
}

/** A bare actor + granter + ONE project request (and its owning company). */
async function seedRequestGrain(): Promise<RequestGrainSeed> {
  const projectRequest = await projectRequestFactory();
  const actor = await userFactory();
  const granter = await userFactory();
  return {
    actorUserId: actor.id,
    grantedByUserId: granter.id,
    companyId: projectRequest.companyId,
    projectRequestId: projectRequest.id,
  };
}

/**
 * The ids of every LIVE (`status='active'`, not soft-deleted) grant for one (actor, company)
 * pair — i.e. exactly the rows the two partial uniques arbitrate over.
 *
 * ⚠ THIS, NOT `expect(a.id).not.toBe(b.id)`, IS HOW "BOTH INSERTS WERE ACCEPTED" IS ASSERTED.
 * Two `defaultRandom()` uuids can never collide, so comparing ids asserts nothing whatsoever;
 * a rejected insert would have THROWN inside the factory, and the surviving row count is the
 * only observable that distinguishes "both landed" from "one did".
 */
async function liveGrantIds(actorUserId: string, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ id: representations.id })
    .from(representations)
    .where(
      and(
        eq(representations.actorUserId, actorUserId),
        eq(representations.onBehalfOfCompanyId, companyId),
        eq(representations.status, 'active'),
        isNull(representations.deletedAt)
      )
    );
  return rows.map((row) => row.id);
}

/** Shared row-shape for the raw CHECK/unique probes below — DRY, mirrors `rawProposalRow`. */
function rawRepresentationRow(
  subject: ActorCompanySeed,
  overrides: Partial<NewRepresentation> = {}
): NewRepresentation {
  return {
    actorUserId: subject.actorUserId,
    onBehalfOfCompanyId: subject.companyId,
    grantedByUserId: subject.grantedByUserId,
    scope: 'org',
    capabilities: ['participate'],
    ...overrides,
  };
}

describe('representations — CHECK and unique backstops', () => {
  it('representation_active_org_idx — two active org grants for the same (actor, company) → 23505', async () => {
    const seed = await seedActorAndCompany();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
    });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(representations).values(rawRepresentationRow(seed))
    );
  });

  it('…the same pair is legal once the first is `status=revoked` — the status half bites', async () => {
    const seed = await seedActorAndCompany();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      status: 'revoked',
      revokedAt: new Date(),
    });

    const [row] = await db.insert(representations).values(rawRepresentationRow(seed)).returning();
    expect(row?.status).toBe('active');
  });

  it('…the same pair is legal once the first has `deleted_at` set — the deleted_at half bites', async () => {
    const seed = await seedActorAndCompany();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      deletedAt: new Date(),
    });

    const [row] = await db.insert(representations).values(rawRepresentationRow(seed)).returning();
    expect(row?.status).toBe('active');
  });

  it('representation_active_request_idx — two active grants, same (actor, company, request) → 23505', async () => {
    const seed = await seedRequestGrain();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
    });

    await expectConstraintViolation('23505', (tx) =>
      tx
        .insert(representations)
        .values(
          rawRepresentationRow(seed, { scope: 'request', projectRequestId: seed.projectRequestId })
        )
    );
  });

  it('…but two active request grants for the same (actor, company) on DIFFERENT requests BOTH insert', async () => {
    const seed = await seedRequestGrain();
    const otherRequest = await projectRequestFactory({ companyId: seed.companyId });

    const first = await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
    });
    const second = await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: otherRequest.id,
    });

    const live = await liveGrantIds(seed.actorUserId, seed.companyId);
    expect(live).toHaveLength(2);
    expect(new Set(live)).toEqual(new Set([first.id, second.id]));
  });

  it('…and an org grant + a request grant for the same (actor, company) coexist', async () => {
    const seed = await seedRequestGrain();

    const orgGrant = await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'org',
    });
    const requestGrant = await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
    });

    const live = await liveGrantIds(seed.actorUserId, seed.companyId);
    expect(live).toHaveLength(2);
    expect(new Set(live)).toEqual(new Set([orgGrant.id, requestGrant.id]));
  });

  it('scope=request with a NULL project_request_id → 23514 (representation_scope_request_paired)', async () => {
    const seed = await seedActorAndCompany();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(representations).values(rawRepresentationRow(seed, { scope: 'request' }))
    );
  });

  it('scope=org with a non-NULL project_request_id → 23514', async () => {
    const seed = await seedRequestGrain();
    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(representations)
        .values(
          rawRepresentationRow(seed, { scope: 'org', projectRequestId: seed.projectRequestId })
        )
    );
  });

  it('capabilities: [] → 23514 (representation_capabilities_nonempty)', async () => {
    const seed = await seedActorAndCompany();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(representations).values(rawRepresentationRow(seed, { capabilities: [] }))
    );
  });

  it('status=revoked with a NULL revoked_at → 23514 (representation_revocation_paired)', async () => {
    const seed = await seedActorAndCompany();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(representations).values(rawRepresentationRow(seed, { status: 'revoked' }))
    );
  });

  it('status=expired with a NULL expires_at → 23514 (representation_expired_requires_expiry)', async () => {
    const seed = await seedActorAndCompany();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(representations).values(rawRepresentationRow(seed, { status: 'expired' }))
    );
  });

  it('an unknown project_request_id → 23503', async () => {
    const seed = await seedActorAndCompany();
    await expectConstraintViolation('23503', (tx) =>
      tx
        .insert(representations)
        .values(rawRepresentationRow(seed, { scope: 'request', projectRequestId: randomUUID() }))
    );
  });

  it('THE TENANCY FK — a request belonging to a DIFFERENT company → 23503 (representation_request_company_fk)', async () => {
    const seed = await seedActorAndCompany();
    // A request seeded with its OWN company — a different tenant from `seed.companyId`.
    const foreignRequest = await projectRequestFactory();
    expect(foreignRequest.companyId).not.toBe(seed.companyId);

    // ⚠ THE ROW IS OTHERWISE PERFECTLY LEGAL: the request EXISTS, `scope='request'` is paired
    // with a non-NULL `project_request_id`, and the capability set is representable. Only the
    // COMPOSITE FK `(project_request_id, on_behalf_of_company_id) → (id, company_id)` refuses
    // it. Without it, BAL-314's "who may act on this request?" read
    // (`representation_project_request_idx`) would hand back a representative of another tenant.
    await expectConstraintViolation('23503', (tx) =>
      tx
        .insert(representations)
        .values(
          rawRepresentationRow(seed, { scope: 'request', projectRequestId: foreignRequest.id })
        )
    );
  });

  it('…and the SAME row inserts once the request belongs to the named company', async () => {
    const seed = await seedRequestGrain();

    const [row] = await db
      .insert(representations)
      .values(
        rawRepresentationRow(seed, { scope: 'request', projectRequestId: seed.projectRequestId })
      )
      .returning();

    expect(row?.projectRequestId).toBe(seed.projectRequestId);
    expect(row?.onBehalfOfCompanyId).toBe(seed.companyId);
  });

  it('…and an ORG-grain row is not touched by it at all (MATCH SIMPLE: a NULL half disables the constraint)', async () => {
    const seed = await seedActorAndCompany();

    const [row] = await db.insert(representations).values(rawRepresentationRow(seed)).returning();

    expect(row?.projectRequestId).toBeNull();
    expect(row?.scope).toBe('org');
  });
});

describe('representationsRepository.grant', () => {
  it('org grant happy path — created:true, capabilities stored normalized, revoked/deleted stay NULL', async () => {
    const seed = await seedActorAndCompany();
    const now = new Date();

    const result = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'org',
        capabilities: ['manage_requests', 'participate'],
        grantedByUserId: seed.grantedByUserId,
      },
      now
    );

    expect(result.created).toBe(true);
    expect(result.representation.status).toBe('active');
    // Deduped + lexicographically sorted, not insertion order.
    expect(result.representation.capabilities).toEqual(['manage_requests', 'participate']);
    expect(result.representation.revokedAt).toBeNull();
    expect(result.representation.revokedByUserId).toBeNull();
    expect(result.representation.deletedAt).toBeNull();
  });

  it('request grant happy path — scope and projectRequestId persisted', async () => {
    const seed = await seedRequestGrain();

    const result = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'request',
        projectRequestId: seed.projectRequestId,
        capabilities: ['participate'],
        grantedByUserId: seed.grantedByUserId,
      },
      new Date()
    );

    expect(result.representation.scope).toBe('request');
    expect(result.representation.projectRequestId).toBe(seed.projectRequestId);
  });

  it('a request-grain grant naming a request owned by ANOTHER company is refused by the database (23503), nothing written', async () => {
    const seed = await seedActorAndCompany();
    const foreignRequest = await projectRequestFactory();
    expect(foreignRequest.companyId).not.toBe(seed.companyId);

    // The FK is the ONLY thing refusing this: `grant()` validates capabilities, scope pairing
    // and expiry, and none of those is about WHOSE request it is. The raw `23503` surfaces
    // because `grant()` rethrows anything that is not one of its two unique violations — and
    // the SAVEPOINT discipline means the outer transaction survives to be queried below.
    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'request',
          projectRequestId: foreignRequest.id,
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
        },
        new Date()
      )
    ).rejects.toMatchObject({ code: '23503' });

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(0);
  });

  it('grant() twice with IDENTICAL input → created:false, SAME id, ONE row — and the ambient transaction survives (Q3/23505 containment)', async () => {
    const seed = await seedActorAndCompany();
    const input = {
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      scope: 'org' as const,
      capabilities: ['participate'] as const,
      grantedByUserId: seed.grantedByUserId,
    };

    const first = await representationsRepository.grant(input, new Date());
    const second = await representationsRepository.grant(input, new Date());

    expect(second.created).toBe(false);
    expect(second.representation.id).toBe(first.representation.id);

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(1);

    // ⚠ THE POINT OF THIS ASSERTION: a statement AFTER the contained 23505 still runs — the
    // savepoint rolled back the failed insert without poisoning the outer transaction (which
    // would answer `25P02` here if the nested `tx.transaction` were missing).
    const stillWorks = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.onBehalfOfCompanyId, seed.companyId));
    expect(stillWorks.length).toBeGreaterThan(0);
  });

  it('a second grant() with DIFFERENT capabilities → RepresentationConflictError carrying the existing id; the stored row is UNCHANGED', async () => {
    const seed = await seedActorAndCompany();
    const first = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'org',
        capabilities: ['participate'],
        grantedByUserId: seed.grantedByUserId,
      },
      new Date()
    );

    let caught: unknown;
    try {
      await representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: ['manage_requests'],
          grantedByUserId: seed.grantedByUserId,
        },
        new Date()
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepresentationConflictError);
    expect((caught as RepresentationConflictError).existingRepresentationId).toBe(
      first.representation.id
    );

    const [reloaded] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, first.representation.id));
    expect(reloaded?.capabilities).toEqual(['participate']);
  });

  it('a second grant() with a DIFFERENT expiresAt (same capabilities) → RepresentationConflictError', async () => {
    const seed = await seedActorAndCompany();
    const now = new Date();
    const first = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'org',
        capabilities: ['participate'],
        grantedByUserId: seed.grantedByUserId,
        expiresAt: new Date(now.getTime() + 30 * MINUTE_MS),
      },
      now
    );

    let caught: unknown;
    try {
      await representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
          expiresAt: new Date(now.getTime() + 60 * MINUTE_MS),
        },
        now
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepresentationConflictError);
    expect((caught as RepresentationConflictError).existingRepresentationId).toBe(
      first.representation.id
    );
  });

  it('order and duplicates are not a difference — normalization makes a scrambled/duplicated input idempotent', async () => {
    const seed = await seedActorAndCompany();
    const first = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'org',
        capabilities: ['manage_requests', 'participate'],
        grantedByUserId: seed.grantedByUserId,
      },
      new Date()
    );

    const second = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'org',
        capabilities: ['participate', 'manage_requests', 'participate'],
        grantedByUserId: seed.grantedByUserId,
      },
      new Date()
    );

    expect(second.created).toBe(false);
    expect(second.representation.id).toBe(first.representation.id);
  });

  it('a non-representable capability (consume_credits) → RepresentationCapabilityError, nothing written — the D3 security AC', async () => {
    const seed = await seedActorAndCompany();

    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: ['consume_credits'],
          grantedByUserId: seed.grantedByUserId,
        },
        new Date()
      )
    ).rejects.toBeInstanceOf(RepresentationCapabilityError);

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(0);
  });

  it('an empty capability list → RepresentationCapabilityError, nothing written', async () => {
    const seed = await seedActorAndCompany();

    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: [],
          grantedByUserId: seed.grantedByUserId,
        },
        new Date()
      )
    ).rejects.toBeInstanceOf(RepresentationCapabilityError);

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(0);
  });

  it('an incoherent scope/projectRequestId pairing → RepresentationScopeError, nothing written', async () => {
    const seed = await seedRequestGrain();

    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'request',
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
        },
        new Date()
      )
    ).rejects.toBeInstanceOf(RepresentationScopeError);

    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          projectRequestId: seed.projectRequestId,
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
        },
        new Date()
      )
    ).rejects.toBeInstanceOf(RepresentationScopeError);

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(0);
  });

  it('an expiresAt at or before now → RepresentationExpiryError, nothing written', async () => {
    const seed = await seedActorAndCompany();
    const now = new Date();

    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
          expiresAt: new Date(now.getTime() - 1000),
        },
        now
      )
    ).rejects.toBeInstanceOf(RepresentationExpiryError);

    await expect(
      representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
          expiresAt: now,
        },
        now
      )
    ).rejects.toBeInstanceOf(RepresentationExpiryError);

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(0);
  });

  it('the LAPSED-SLOT RELEASE (A0.1) — grant() after a lapse SUCCEEDS; the old row becomes expired, revoked_at/revoked_by_user_id stay NULL', async () => {
    const seed = await seedActorAndCompany();
    const now = new Date();
    const lapsed = await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      expiresAt: new Date(now.getTime() - MINUTE_MS),
    });

    // Without `expireLapsedForSubject` running first, this would fail 23505 forever.
    const result = await representationsRepository.grant(
      {
        actorUserId: seed.actorUserId,
        onBehalfOfCompanyId: seed.companyId,
        scope: 'org',
        capabilities: ['participate'],
        grantedByUserId: seed.grantedByUserId,
      },
      now
    );

    expect(result.created).toBe(true);
    expect(result.representation.id).not.toBe(lapsed.id);

    const [reloadedLapsed] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, lapsed.id));
    expect(reloadedLapsed?.status).toBe('expired');
    expect(reloadedLapsed?.revokedAt).toBeNull();
    expect(reloadedLapsed?.revokedByUserId).toBeNull();

    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(eq(representations.actorUserId, seed.actorUserId));
    expect(rows).toHaveLength(2);
  });

  it('composes under a caller transaction — a sibling write in the same tx sees the row', async () => {
    const seed = await seedActorAndCompany();
    const now = new Date();

    await db.transaction(async (tx) => {
      const { representation } = await representationsRepository.grant(
        {
          actorUserId: seed.actorUserId,
          onBehalfOfCompanyId: seed.companyId,
          scope: 'org',
          capabilities: ['participate'],
          grantedByUserId: seed.grantedByUserId,
        },
        now,
        tx
      );

      const [sibling] = await tx
        .select()
        .from(representations)
        .where(eq(representations.id, representation.id));
      expect(sibling?.id).toBe(representation.id);
    });

    const [committed] = await db
      .select()
      .from(representations)
      .where(
        and(
          eq(representations.actorUserId, seed.actorUserId),
          eq(representations.onBehalfOfCompanyId, seed.companyId)
        )
      );
    expect(committed?.status).toBe('active');
  });
});

describe('representationsRepository — expiry boundary (D6, `gt` not `gte`)', () => {
  it('expires_at = now + 1ms is still ACTIVE', async () => {
    const now = new Date();
    const grant = await representationFactory({ expiresAt: new Date(now.getTime() + 1) });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: grant.onBehalfOfCompanyId },
        now
      )
    ).toEqual(['participate']);
    expect(await representationsRepository.findActiveForActor(grant.actorUserId, now)).toHaveLength(
      1
    );
  });

  it("expires_at EXACTLY now is INACTIVE — while the row's `status` column STILL reads active", async () => {
    const now = new Date();
    const grant = await representationFactory({ expiresAt: now });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: grant.onBehalfOfCompanyId },
        now
      )
    ).toEqual([]);
    expect(await representationsRepository.findActiveForActor(grant.actorUserId, now)).toEqual([]);

    // ⚠ THE WHOLE POINT: the predicate REFUSES it; the column still REPORTS active. Expiry is
    // lazy — nothing has swept this row yet.
    const [reloaded] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, grant.id));
    expect(reloaded?.status).toBe('active');
  });

  it('expires_at in the past is INACTIVE', async () => {
    const now = new Date();
    const grant = await representationFactory({ expiresAt: new Date(now.getTime() - 1000) });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: grant.onBehalfOfCompanyId },
        now
      )
    ).toEqual([]);
    expect(await representationsRepository.findActiveForActor(grant.actorUserId, now)).toEqual([]);
  });

  it('expires_at = null is active indefinitely', async () => {
    const grant = await representationFactory({ expiresAt: null });
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * MINUTE_MS);

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: grant.onBehalfOfCompanyId },
        farFuture
      )
    ).toEqual(['participate']);
  });
});

describe('representationsRepository.expireLapsedForSubject', () => {
  it('moves a lapsed row to expired (1); a future-dated row and an already-revoked row are no-ops (0)', async () => {
    const now = new Date();
    const lapsed = await representationFactory({ expiresAt: new Date(now.getTime() - 1000) });
    const future = await representationFactory({ expiresAt: new Date(now.getTime() + 100_000) });
    const revoked = await representationFactory({
      status: 'revoked',
      revokedAt: now,
      expiresAt: new Date(now.getTime() - 1000),
    });

    expect(
      await representationsRepository.expireLapsedForSubject(
        { actorUserId: lapsed.actorUserId, companyId: lapsed.onBehalfOfCompanyId },
        now
      )
    ).toBe(1);
    expect(
      await representationsRepository.expireLapsedForSubject(
        { actorUserId: future.actorUserId, companyId: future.onBehalfOfCompanyId },
        now
      )
    ).toBe(0);
    expect(
      await representationsRepository.expireLapsedForSubject(
        { actorUserId: revoked.actorUserId, companyId: revoked.onBehalfOfCompanyId },
        now
      )
    ).toBe(0);

    const [reloadedLapsed] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, lapsed.id));
    expect(reloadedLapsed?.status).toBe('expired');
  });
});

describe('representationsRepository.revoke', () => {
  it('revokes an active grant — status, revoked_at, revoked_by_user_id set; deleted_at stays NULL', async () => {
    const grant = await representationFactory();
    const revoker = await userFactory();
    const now = new Date();

    const revoked = await representationsRepository.revoke(
      {
        representationId: grant.id,
        onBehalfOfCompanyId: grant.onBehalfOfCompanyId,
        revokedByUserId: revoker.id,
      },
      now
    );

    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedAt?.getTime()).toBe(now.getTime());
    expect(revoked?.revokedByUserId).toBe(revoker.id);
    expect(revoked?.deletedAt).toBeNull();
  });

  it('a second revoke() of the same id returns undefined — the double-revoke race is closed by the CAS', async () => {
    const grant = await representationFactory();
    const revoker = await userFactory();
    await representationsRepository.revoke(
      {
        representationId: grant.id,
        onBehalfOfCompanyId: grant.onBehalfOfCompanyId,
        revokedByUserId: revoker.id,
      },
      new Date()
    );

    expect(
      await representationsRepository.revoke(
        {
          representationId: grant.id,
          onBehalfOfCompanyId: grant.onBehalfOfCompanyId,
          revokedByUserId: revoker.id,
        },
        new Date()
      )
    ).toBeUndefined();
  });

  it('the WRONG onBehalfOfCompanyId returns undefined and leaves the row UNCHANGED — the IDOR containment term', async () => {
    const grant = await representationFactory();
    const otherCompany = await companyFactory();
    const revoker = await userFactory();

    expect(
      await representationsRepository.revoke(
        {
          representationId: grant.id,
          onBehalfOfCompanyId: otherCompany.id,
          revokedByUserId: revoker.id,
        },
        new Date()
      )
    ).toBeUndefined();

    const [reloaded] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, grant.id));
    expect(reloaded?.status).toBe('active');
    expect(reloaded?.revokedAt).toBeNull();
  });

  it('an unknown id returns undefined — indistinguishable from the wrong-company case', async () => {
    const revoker = await userFactory();

    expect(
      await representationsRepository.revoke(
        {
          representationId: randomUUID(),
          onBehalfOfCompanyId: randomUUID(),
          revokedByUserId: revoker.id,
        },
        new Date()
      )
    ).toBeUndefined();
  });

  it('a LAPSED-but-`active` grant CAN be revoked — the one intended asymmetry with liveRepresentation', async () => {
    const now = new Date();
    const grant = await representationFactory({ expiresAt: new Date(now.getTime() - 1000) });
    const revoker = await userFactory();

    const revoked = await representationsRepository.revoke(
      {
        representationId: grant.id,
        onBehalfOfCompanyId: grant.onBehalfOfCompanyId,
        revokedByUserId: revoker.id,
      },
      now
    );
    expect(revoked?.status).toBe('revoked');
  });

  it('after revoke, activeCapabilitiesFor is [] and the slot is free — a fresh grant() succeeds', async () => {
    const grant = await representationFactory();
    const revoker = await userFactory();
    await representationsRepository.revoke(
      {
        representationId: grant.id,
        onBehalfOfCompanyId: grant.onBehalfOfCompanyId,
        revokedByUserId: revoker.id,
      },
      new Date()
    );

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: grant.onBehalfOfCompanyId },
        new Date()
      )
    ).toEqual([]);

    const regranted = await representationsRepository.grant(
      {
        actorUserId: grant.actorUserId,
        onBehalfOfCompanyId: grant.onBehalfOfCompanyId,
        scope: 'org',
        capabilities: ['participate'],
        grantedByUserId: grant.grantedByUserId,
      },
      new Date()
    );
    expect(regranted.created).toBe(true);
  });
});

describe('representationsRepository.activeCapabilitiesFor — the grain question (Q5)', () => {
  it('an org grant answers a question asked WITHOUT a projectRequestId', async () => {
    const grant = await representationFactory({ capabilities: ['participate'] });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: grant.onBehalfOfCompanyId },
        new Date()
      )
    ).toEqual(['participate']);
  });

  it('an org grant answers a question asked WITH a projectRequestId — the widening arm', async () => {
    const grant = await representationFactory({ capabilities: ['participate'] });
    const projectRequest = await projectRequestFactory({ companyId: grant.onBehalfOfCompanyId });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        {
          actorUserId: grant.actorUserId,
          companyId: grant.onBehalfOfCompanyId,
          projectRequestId: projectRequest.id,
        },
        new Date()
      )
    ).toEqual(['participate']);
  });

  it('a request grant for X answers a question asked WITH X', async () => {
    const seed = await seedRequestGrain();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
      capabilities: ['manage_requests'],
    });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        {
          actorUserId: seed.actorUserId,
          companyId: seed.companyId,
          projectRequestId: seed.projectRequestId,
        },
        new Date()
      )
    ).toEqual(['manage_requests']);
  });

  it('a request grant for X does NOT answer a question asked WITH a DIFFERENT request Y', async () => {
    const seed = await seedRequestGrain();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
      capabilities: ['manage_requests'],
    });
    const otherRequest = await projectRequestFactory({ companyId: seed.companyId });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        {
          actorUserId: seed.actorUserId,
          companyId: seed.companyId,
          projectRequestId: otherRequest.id,
        },
        new Date()
      )
    ).toEqual([]);
  });

  it('a request grant for X does NOT answer an ORG-grain question — the escalation guard', async () => {
    const seed = await seedRequestGrain();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
      capabilities: ['manage_requests'],
    });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: seed.actorUserId, companyId: seed.companyId },
        new Date()
      )
    ).toEqual([]);
  });

  it('an org grant [participate] + a request grant [manage_requests] for X union, deduped and sorted, asked WITH X', async () => {
    const seed = await seedRequestGrain();
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'org',
      capabilities: ['participate'],
    });
    await representationFactory({
      actorUserId: seed.actorUserId,
      onBehalfOfCompanyId: seed.companyId,
      grantedByUserId: seed.grantedByUserId,
      scope: 'request',
      projectRequestId: seed.projectRequestId,
      capabilities: ['manage_requests'],
    });

    expect(
      await representationsRepository.activeCapabilitiesFor(
        {
          actorUserId: seed.actorUserId,
          companyId: seed.companyId,
          projectRequestId: seed.projectRequestId,
        },
        new Date()
      )
    ).toEqual(['manage_requests', 'participate']);
  });

  it('a DIFFERENT company yields [], and a DIFFERENT actor yields []', async () => {
    const grant = await representationFactory({ capabilities: ['participate'] });
    const otherCompany = await companyFactory();
    const otherActor = await userFactory();

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: grant.actorUserId, companyId: otherCompany.id },
        new Date()
      )
    ).toEqual([]);
    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: otherActor.id, companyId: grant.onBehalfOfCompanyId },
        new Date()
      )
    ).toEqual([]);
  });

  it('the READ-SIDE allowlist filter strips a non-representable capability from a raw-inserted row', async () => {
    const seed = await seedActorAndCompany();
    // Bypasses `grant()` entirely — what a script or hand-edit looks like. `$type<Capability[]>()`
    // is a compile-time claim Postgres does not enforce; the CHECK pins only "non-empty array".
    await db
      .insert(representations)
      .values(rawRepresentationRow(seed, { capabilities: ['participate', 'consume_credits'] }));

    expect(
      await representationsRepository.activeCapabilitiesFor(
        { actorUserId: seed.actorUserId, companyId: seed.companyId },
        new Date()
      )
    ).toEqual(['participate']);
  });

  it('no grants at all returns [], never undefined', async () => {
    const seed = await seedActorAndCompany();

    const result = await representationsRepository.activeCapabilitiesFor(
      { actorUserId: seed.actorUserId, companyId: seed.companyId },
      new Date()
    );
    expect(result).toEqual([]);
  });
});

describe('representationsRepository.findActiveForActor', () => {
  it('returns live grants across TWO companies for one actor, newest first, excluding revoked/expired/lapsed/soft-deleted', async () => {
    const actor = await userFactory();
    const granter = await userFactory();
    const companyA = await companyFactory();
    const companyB = await companyFactory();
    const now = new Date();

    // ⚠ BOTH `createdAt` VALUES ARE EXPLICIT, AND THAT IS LOAD-BEARING. The column defaults to
    // `now()`, which in Postgres is the TRANSACTION-START timestamp — the testcontainer's
    // clock, not the host's. Letting `newer` default would make this ordering assertion
    // silently depend on the two clocks agreeing, and it would flake (or worse, pass for the
    // wrong reason) whenever they drifted.
    const older = await representationFactory({
      actorUserId: actor.id,
      onBehalfOfCompanyId: companyA.id,
      grantedByUserId: granter.id,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const newer = await representationFactory({
      actorUserId: actor.id,
      onBehalfOfCompanyId: companyB.id,
      grantedByUserId: granter.id,
      createdAt: now,
    });

    // Excluded from the result — one of each disqualifying state.
    await representationFactory({
      actorUserId: actor.id,
      onBehalfOfCompanyId: (await companyFactory()).id,
      grantedByUserId: granter.id,
      status: 'revoked',
      revokedAt: now,
    });
    await representationFactory({
      actorUserId: actor.id,
      onBehalfOfCompanyId: (await companyFactory()).id,
      grantedByUserId: granter.id,
      status: 'expired',
      expiresAt: new Date(now.getTime() - 1000),
    });
    await representationFactory({
      actorUserId: actor.id,
      onBehalfOfCompanyId: (await companyFactory()).id,
      grantedByUserId: granter.id,
      expiresAt: new Date(now.getTime() - 1000), // lapsed-but-`active`
    });
    await representationFactory({
      actorUserId: actor.id,
      onBehalfOfCompanyId: (await companyFactory()).id,
      grantedByUserId: granter.id,
      deletedAt: now,
    });

    const active = await representationsRepository.findActiveForActor(actor.id, now);
    expect(active.map((row) => row.id)).toEqual([newer.id, older.id]);
  });

  it('capabilities on each RETURNED ROW are allowlist-filtered too — the twin of the activeCapabilitiesFor filter', async () => {
    const seed = await seedActorAndCompany();
    // Bypasses `grant()` entirely — what a seed, a script or a hand edit looks like. Without
    // the boundary filter this read hands `consume_credits` back typed `Capability[]`, with
    // the full blessing of the type system, and the caller draws down the customer's wallet.
    await db
      .insert(representations)
      .values(rawRepresentationRow(seed, { capabilities: ['participate', 'consume_credits'] }));

    const [row] = await representationsRepository.findActiveForActor(seed.actorUserId, new Date());
    expect(row?.capabilities).toEqual(['participate']);
  });
});
