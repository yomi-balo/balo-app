import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  requestExpertRelationships,
  requestFileGrants,
  requestSharedFiles,
} from '../schema';
import {
  expertDraftFactory,
  requestExpertRelationshipFactory,
  userFactory,
  engagementFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  requestSharedFilesRepository,
  RequestFileAlreadyDeletedError,
  RequestFileGrantNotFoundError,
  RequestFileNotFoundError,
  RequestFileTrackNotLiveError,
  type ShareRequestFileInput,
} from './request-shared-files';

/**
 * BAL-431 / ADR-1048 — `request_shared_files` + `request_file_grants`, the FIFTH file scope.
 *
 * ⚠ REPOSITORY REJECTIONS ARE SAVEPOINT-ISOLATED HERE, RAW ONES ARE NOT. Every mutating
 * method self-wraps `db.transaction(run)` when given no executor, and under the harness `db`
 * IS the outer per-test transaction — so a nested `db.transaction` is a SAVEPOINT and a
 * failing repository call rolls back only its own work. RAW probes must still go through
 * `expectConstraintViolation`, which supplies that savepoint explicitly.
 */

/** A fresh, never-reused R2 key — the shape the request-file key generator will mint. */
function freshR2Key(projectRequestId: string, userId: string): string {
  return `request-files/${projectRequestId}/${userId}/${randomUUID()}`;
}

interface SeededTrack {
  relationshipId: string;
  expertProfileId: string;
}

interface Seed {
  projectRequestId: string;
  /** A client-side member — the sharing actor for `all_live_tracks` / `grants`. */
  clientUserId: string;
  tracks: SeededTrack[];
}

/** Seed one request carrying `trackCount` LIVE `invited` tracks. */
async function seedRequest(trackCount: number): Promise<Seed> {
  const first = await requestExpertRelationshipFactory();
  const tracks: SeededTrack[] = [
    { relationshipId: first.relationship.id, expertProfileId: first.expertProfileId },
  ];

  for (let i = 1; i < trackCount; i += 1) {
    const expert = await expertDraftFactory();
    const extra = await requestExpertRelationshipFactory({
      projectRequestId: first.projectRequestId,
      expertProfileId: expert.id,
      invitedByUserId: first.invitedByUserId,
    });
    tracks.push({ relationshipId: extra.relationship.id, expertProfileId: extra.expertProfileId });
  }

  const client = await userFactory();
  return { projectRequestId: first.projectRequestId, clientUserId: client.id, tracks };
}

function shareInput(
  seed: Seed,
  overrides: Partial<ShareRequestFileInput> = {}
): ShareRequestFileInput {
  return {
    projectRequestId: seed.projectRequestId,
    uploadedByUserId: seed.clientUserId,
    side: 'client',
    audience: 'all_live_tracks',
    expertRelationshipId: null,
    grantRelationshipIds: [],
    r2Key: freshR2Key(seed.projectRequestId, seed.clientUserId),
    fileName: 'discovery-brief.pdf',
    contentType: 'application/pdf',
    sizeBytes: 24_576,
    ...overrides,
  };
}

/** Every audit row for one file, in a DETERMINISTIC order (see below). */
async function auditRowsFor(
  fileId: string
): Promise<
  { action: string; actorUserId: string | null; entityType: string; metadata: unknown }[]
> {
  const rows = await db
    .select({
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      entityType: auditEvents.entityType,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, fileId))
    // ⚠ NOT `created_at`. `defaultNow()` is the TRANSACTION timestamp, so every row written
    // by one `share()` carries the SAME instant and ordering by it is non-deterministic.
    .orderBy(asc(auditEvents.action), asc(auditEvents.id));
  return rows;
}

async function closeTrack(
  relationshipId: string,
  how: 'declined' | 'withdrawn' | 'not_selected'
): Promise<void> {
  const at = new Date();
  if (how === 'declined') {
    await db
      .update(requestExpertRelationships)
      .set({ status: 'declined', declinedAt: at })
      .where(eq(requestExpertRelationships.id, relationshipId));
    return;
  }
  if (how === 'withdrawn') {
    await db
      .update(requestExpertRelationships)
      .set({ deletedAt: at })
      .where(eq(requestExpertRelationships.id, relationshipId));
    return;
  }
  await db
    .update(requestExpertRelationships)
    .set({ notSelectedAt: at })
    .where(eq(requestExpertRelationships.id, relationshipId));
}

// ── share() ────────────────────────────────────────────────────────────

describe('requestSharedFilesRepository.share', () => {
  it('shares to ALL LIVE TRACKS, writes no grant rows, and snapshots the live set', async () => {
    const seed = await seedRequest(3);

    const result = await requestSharedFilesRepository.share(shareInput(seed));

    expect(result.file.side).toBe('client');
    expect(result.file.audience).toBe('all_live_tracks');
    expect(result.file.expertRelationshipId).toBeNull();
    expect(result.file.deletedAt).toBeNull();
    expect(result.file.deletedByUserId).toBeNull();

    // ⚠ AN `all_live_tracks` FILE HAS NO GRANT ROWS BY CONSTRUCTION — its audience is
    // computed at READ time. Materialising it would be the snapshotted-audience model
    // ADR-1048 rejected as its option 3.
    expect(result.grants).toEqual([]);

    expect(result.resolvedLiveTracks.map((e) => e.relationshipId).sort()).toEqual(
      seed.tracks.map((t) => t.relationshipId).sort()
    );
    expect(result.resolvedLiveTracks.every((e) => e.via === 'all_live_tracks')).toBe(true);
  });

  it('shares to EXPLICIT GRANTS, one live grant row per named track', async () => {
    const seed = await seedRequest(3);
    const [t0, t1] = seed.tracks;
    if (t0 === undefined || t1 === undefined) throw new Error('seed produced too few tracks');

    const result = await requestSharedFilesRepository.share(
      shareInput(seed, {
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId, t1.relationshipId],
      })
    );

    expect(result.grants).toHaveLength(2);
    expect(result.grants.map((g) => g.relationshipId).sort()).toEqual(
      [t0.relationshipId, t1.relationshipId].sort()
    );
    expect(result.grants.every((g) => g.projectRequestId === seed.projectRequestId)).toBe(true);
    expect(result.grants.every((g) => g.grantedByUserId === seed.clientUserId)).toBe(true);
    expect(result.grants.every((g) => g.revokedByUserId === null)).toBe(true);

    expect(result.resolvedLiveTracks.map((e) => e.relationshipId).sort()).toEqual(
      [t0.relationshipId, t1.relationshipId].sort()
    );
    expect(result.resolvedLiveTracks.every((e) => e.via === 'grant')).toBe(true);
  });

  it('de-duplicates repeated grant targets rather than raising a raw 23505', async () => {
    const seed = await seedRequest(2);
    const [t0] = seed.tracks;
    if (t0 === undefined) throw new Error('seed produced no tracks');

    const result = await requestSharedFilesRepository.share(
      shareInput(seed, {
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId, t0.relationshipId, t0.relationshipId],
      })
    );

    expect(result.grants).toHaveLength(1);
  });

  /**
   * ⚠ THE SHAPE GUARD REFUSES INCOHERENT SHARES BEFORE ANY WRITE. `side`, `audience` and the
   * grant targets are three fields that must agree; a mismatch is a caller bug, and letting one
   * through writes a row whose audience cannot be resolved consistently afterwards — grants
   * attached to an all-tracks file would be invisible to the audience rule but present in the
   * table. Each case must throw and leave NOTHING behind.
   */
  describe('refuses an incoherent share shape before writing anything', () => {
    it('rejects grant targets supplied alongside a non-grants audience', async () => {
      const seed = await seedRequest(2);
      const [t0] = seed.tracks;
      if (t0 === undefined) throw new Error('seed produced no tracks');

      await expect(
        requestSharedFilesRepository.share(
          shareInput(seed, {
            audience: 'all_live_tracks',
            grantRelationshipIds: [t0.relationshipId],
          })
        )
      ).rejects.toThrow(/grantRelationshipIds supplied for audience=all_live_tracks/);

      const rows = await db
        .select()
        .from(requestSharedFiles)
        .where(eq(requestSharedFiles.projectRequestId, seed.projectRequestId));
      expect(rows).toHaveLength(0);
    });

    /**
     * A `grants` share with no target would create a file nobody can read while presenting to
     * the client as a successful share — the worst possible outcome for a sensitive document.
     */
    it('rejects a grants share naming no tracks at all', async () => {
      const seed = await seedRequest(2);

      await expect(
        requestSharedFilesRepository.share(
          shareInput(seed, { audience: 'grants', grantRelationshipIds: [] })
        )
      ).rejects.toThrow(/audience=grants requires at least one grant target/);

      const rows = await db
        .select()
        .from(requestSharedFiles)
        .where(eq(requestSharedFiles.projectRequestId, seed.projectRequestId));
      expect(rows).toHaveLength(0);
    });
  });

  it('records an EXPERT upload fixed to its own track, with no grants', async () => {
    const seed = await seedRequest(2);
    const [own] = seed.tracks;
    if (own === undefined) throw new Error('seed produced no tracks');
    const expertUser = await userFactory();

    const result = await requestSharedFilesRepository.share(
      shareInput(seed, {
        uploadedByUserId: expertUser.id,
        side: 'expert',
        audience: 'own_track',
        expertRelationshipId: own.relationshipId,
      })
    );

    expect(result.file.expertRelationshipId).toBe(own.relationshipId);
    expect(result.grants).toEqual([]);
    expect(result.resolvedLiveTracks).toEqual([
      {
        relationshipId: own.relationshipId,
        expertProfileId: own.expertProfileId,
        via: 'own_track',
      },
    ]);
  });

  it.each([
    ['client', 'own_track', true],
    ['client', 'all_live_tracks', true],
    ['expert', 'all_live_tracks', false],
    ['expert', 'own_track', false],
  ] as const)(
    'refuses the incoherent shape side=%s audience=%s before touching the database',
    async (side, audience, withTrack) => {
      const seed = await seedRequest(1);
      const [own] = seed.tracks;
      if (own === undefined) throw new Error('seed produced no tracks');

      await expect(
        requestSharedFilesRepository.share(
          shareInput(seed, {
            side,
            audience,
            expertRelationshipId: withTrack ? own.relationshipId : null,
          })
        )
      ).rejects.toThrow(/Incoherent request file share shape/);
    }
  );

  it('rejects a duplicate `r2Key` with a RAW 23505 — nothing here catches it', async () => {
    const seed = await seedRequest(1);
    const key = freshR2Key(seed.projectRequestId, seed.clientUserId);

    await requestSharedFilesRepository.share(shareInput(seed, { r2Key: key }));

    await expect(
      requestSharedFilesRepository.share(shareInput(seed, { r2Key: key }))
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ── The closed-track invariant (ADR-1048 §7, invariant 4) ──────────────

describe('a CLOSED track never gains new visibility', () => {
  it.each(['declined', 'withdrawn', 'not_selected'] as const)(
    'rejects a %s track as a grant target and rolls the WHOLE share back',
    async (how) => {
      const seed = await seedRequest(2);
      const [live, closing] = seed.tracks;
      if (live === undefined || closing === undefined) throw new Error('seed too small');
      await closeTrack(closing.relationshipId, how);

      const key = freshR2Key(seed.projectRequestId, seed.clientUserId);
      await expect(
        requestSharedFilesRepository.share(
          shareInput(seed, {
            r2Key: key,
            audience: 'grants',
            grantRelationshipIds: [live.relationshipId, closing.relationshipId],
          })
        )
      ).rejects.toBeInstanceOf(RequestFileTrackNotLiveError);

      // ⚠ THE WHOLE TRANSACTION ROLLED BACK — no file row, and therefore no grant to the
      // LIVE co-target either. A partial share would leak a file nobody asked to share.
      const orphans = await db
        .select()
        .from(requestSharedFiles)
        .where(eq(requestSharedFiles.r2Key, key));
      expect(orphans).toEqual([]);
    }
  );

  it.each(['declined', 'not_selected'] as const)(
    'excludes a %s track from a NEW all-tracks share',
    async (how) => {
      const seed = await seedRequest(3);
      const [live, closing] = seed.tracks;
      if (live === undefined || closing === undefined) throw new Error('seed too small');
      await closeTrack(closing.relationshipId, how);

      const result = await requestSharedFilesRepository.share(shareInput(seed));

      const visible = result.resolvedLiveTracks.map((e) => e.relationshipId);
      expect(visible).toContain(live.relationshipId);
      expect(visible).not.toContain(closing.relationshipId);
    }
  );

  it('drops a WITHDRAWN (soft-deleted) track from the resolved set entirely', async () => {
    const seed = await seedRequest(2);
    const [live, gone] = seed.tracks;
    if (live === undefined || gone === undefined) throw new Error('seed too small');
    await closeTrack(gone.relationshipId, 'withdrawn');

    const result = await requestSharedFilesRepository.share(shareInput(seed));

    expect(result.resolvedLiveTracks.map((e) => e.relationshipId)).toEqual([live.relationshipId]);
  });

  /**
   * THE POSITIVE HALF (ADR-1048 §2): decline ends the FUTURE, not the PAST. A share made
   * BEFORE closure stays readable — asserted through `listForEngagement`, the only shipped
   * consumer of the read rule inside `@balo/db`.
   */
  it('keeps a PRE-closure all-tracks share readable by the track that later closed', async () => {
    const seed = await seedRequest(2);
    const [winner, loser] = seed.tracks;
    if (winner === undefined || loser === undefined) throw new Error('seed too small');

    await requestSharedFilesRepository.share(shareInput(seed, { fileName: 'shared-early.pdf' }));

    // The loser closes AFTER the share.
    await closeTrack(loser.relationshipId, 'not_selected');

    const { engagement } = await engagementFactory({
      projectValues: {
        projectRequestId: seed.projectRequestId,
        relationshipId: loser.relationshipId,
      },
    });

    const visible = await requestSharedFilesRepository.listForEngagement(engagement.id, {
      companyId: engagement.companyId,
    });
    expect(visible.map((f) => f.file.fileName)).toEqual(['shared-early.pdf']);
  });

  /**
   * ⚠ GRANTS SURVIVE CLOSURE UNCONDITIONALLY, asserted DIRECTLY rather than by relying on
   * "a new grant to a closed track is impossible" ordering — the design reference makes the
   * same choice (`request-file-audience.jsx:204` returns before the decline check at `:205`).
   */
  it('keeps an existing GRANT readable after its track declines', async () => {
    const seed = await seedRequest(2);
    const [target] = seed.tracks;
    if (target === undefined) throw new Error('seed too small');

    await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'granted-early.pdf',
        audience: 'grants',
        grantRelationshipIds: [target.relationshipId],
      })
    );
    await closeTrack(target.relationshipId, 'declined');

    const { engagement } = await engagementFactory({
      projectValues: {
        projectRequestId: seed.projectRequestId,
        relationshipId: target.relationshipId,
      },
    });

    const visible = await requestSharedFilesRepository.listForEngagement(engagement.id, {
      companyId: engagement.companyId,
    });
    expect(visible.map((f) => f.file.fileName)).toEqual(['granted-early.pdf']);
  });
});

// ── Structural constraints ─────────────────────────────────────────────

describe('the database enforces the audience shape structurally', () => {
  /**
   * ⚠ ASSERTED AS A DELIBERATE PROPERTY, NOT A BUG. `request_shared_file_key_idx` is
   * NON-partial, so a soft-deleted row's `r2_key` stays RESERVED — which is exactly what
   * makes a best-effort R2 object delete safe to fail. Making it partial would be actively
   * wrong here.
   */
  it('keeps a soft-deleted file’s `r2_key` reserved (NON-partial unique)', async () => {
    const seed = await seedRequest(1);
    const key = freshR2Key(seed.projectRequestId, seed.clientUserId);
    const { file } = await requestSharedFilesRepository.share(shareInput(seed, { r2Key: key }));

    await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: seed.clientUserId,
    });

    await expect(
      requestSharedFilesRepository.share(shareInput(seed, { r2Key: key }))
    ).rejects.toMatchObject({ code: '23505' });
  });

  /**
   * The OPPOSITE call from `r2_key`, deliberately: a (file, track) pair IS a reusable tuple,
   * so `request_file_grant_unique_idx` is PARTIAL on `deleted_at IS NULL` and a re-grant
   * after a revoke succeeds (memory `reference_softdelete_nonpartial_unique_recreate`).
   */
  it('frees the (file, track) unique slot on revoke so the pair can be granted again', async () => {
    const seed = await seedRequest(1);
    const [target] = seed.tracks;
    if (target === undefined) throw new Error('seed too small');

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, { audience: 'grants', grantRelationshipIds: [target.relationshipId] })
    );
    await requestSharedFilesRepository.revokeGrant({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      relationshipId: target.relationshipId,
      actorUserId: seed.clientUserId,
    });

    const [regranted] = await db
      .insert(requestFileGrants)
      .values({
        fileId: file.id,
        relationshipId: target.relationshipId,
        projectRequestId: seed.projectRequestId,
        grantedByUserId: seed.clientUserId,
      })
      .returning();

    expect(regranted?.deletedAt).toBeNull();
  });

  /**
   * ⚠⚠ THE CROSS-REQUEST INVARIANT (ADR-1048 §7), MADE STRUCTURAL. A grant joining request
   * X's file to request Y's track is UNREPRESENTABLE — the database refuses it, so it is not
   * a rule anyone has to remember.
   */
  it('refuses a grant joining one request’s file to ANOTHER request’s track', async () => {
    const seedX = await seedRequest(1);
    const seedY = await seedRequest(1);
    const [foreign] = seedY.tracks;
    if (foreign === undefined) throw new Error('seed too small');

    const { file } = await requestSharedFilesRepository.share(shareInput(seedX));

    // Naming X's request id keeps the rel↔request FK unsatisfiable; naming Y's keeps the
    // file↔request FK unsatisfiable. BOTH backstops are proven by probing both directions.
    await expectConstraintViolation('23503', (tx) =>
      tx.insert(requestFileGrants).values({
        fileId: file.id,
        relationshipId: foreign.relationshipId,
        projectRequestId: seedX.projectRequestId,
        grantedByUserId: seedX.clientUserId,
      })
    );
    await expectConstraintViolation('23503', (tx) =>
      tx.insert(requestFileGrants).values({
        fileId: file.id,
        relationshipId: foreign.relationshipId,
        projectRequestId: seedY.projectRequestId,
        grantedByUserId: seedX.clientUserId,
      })
    );
  });

  it.each([
    ['expert with a client audience', { side: 'expert', audience: 'all_live_tracks', track: true }],
    ['expert with no named track', { side: 'expert', audience: 'own_track', track: false }],
    ['client with own_track', { side: 'client', audience: 'own_track', track: false }],
    ['client naming a track', { side: 'client', audience: 'all_live_tracks', track: true }],
  ] as const)('rejects the illegal row shape: %s', async (_label, shape) => {
    const seed = await seedRequest(1);
    const [own] = seed.tracks;
    if (own === undefined) throw new Error('seed too small');

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(requestSharedFiles).values({
        projectRequestId: seed.projectRequestId,
        uploadedByUserId: seed.clientUserId,
        side: shape.side,
        audience: shape.audience,
        expertRelationshipId: shape.track ? own.relationshipId : null,
        r2Key: freshR2Key(seed.projectRequestId, seed.clientUserId),
        fileName: 'illegal.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      })
    );
  });

  it('refuses a half-written tombstone (deleted_at without a deleter, and vice versa)', async () => {
    const seed = await seedRequest(1);
    const { file } = await requestSharedFilesRepository.share(shareInput(seed));

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(requestSharedFiles)
        .set({ deletedAt: new Date() })
        .where(eq(requestSharedFiles.id, file.id))
    );
    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(requestSharedFiles)
        .set({ deletedByUserId: seed.clientUserId })
        .where(eq(requestSharedFiles.id, file.id))
    );
  });

  it('refuses a half-written grant revocation', async () => {
    const seed = await seedRequest(1);
    const [target] = seed.tracks;
    if (target === undefined) throw new Error('seed too small');
    const { grants } = await requestSharedFilesRepository.share(
      shareInput(seed, { audience: 'grants', grantRelationshipIds: [target.relationshipId] })
    );
    const [grant] = grants;
    if (grant === undefined) throw new Error('no grant written');

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(requestFileGrants)
        .set({ deletedAt: new Date() })
        .where(eq(requestFileGrants.id, grant.id))
    );
  });
});

// ── Containment (the IDOR replacement) ─────────────────────────────────

describe('requestSharedFilesRepository.findByIdInRequest', () => {
  /**
   * ⚠ THE CONTAINMENT PROOF. `projectRequestId` is a WHERE term, not a post-filter, so a file
   * on another request answers `undefined` — identically to a stale uuid. This is the direct
   * replacement for `listFiles(access.conversationId, …).find(…)`, which a request-grain file
   * dissolves.
   */
  it('returns undefined for a file belonging to ANOTHER request', async () => {
    const seedX = await seedRequest(1);
    const seedY = await seedRequest(1);
    const { file } = await requestSharedFilesRepository.share(shareInput(seedX));

    await expect(
      requestSharedFilesRepository.findByIdInRequest(file.id, seedY.projectRequestId)
    ).resolves.toBeUndefined();
    await expect(
      requestSharedFilesRepository.findByIdInRequest(randomUUID(), seedX.projectRequestId)
    ).resolves.toBeUndefined();

    const found = await requestSharedFilesRepository.findByIdInRequest(
      file.id,
      seedX.projectRequestId
    );
    expect(found?.file.id).toBe(file.id);
  });

  it('hides a tombstone unless `includeDeleted` is named explicitly', async () => {
    const seed = await seedRequest(1);
    const { file } = await requestSharedFilesRepository.share(shareInput(seed));
    await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: seed.clientUserId,
    });

    await expect(
      requestSharedFilesRepository.findByIdInRequest(file.id, seed.projectRequestId)
    ).resolves.toBeUndefined();

    const withDeleted = await requestSharedFilesRepository.findByIdInRequest(
      file.id,
      seed.projectRequestId,
      { includeDeleted: true }
    );
    expect(withDeleted?.file.deletedAt).not.toBeNull();
  });

  it('returns only LIVE grants alongside the file', async () => {
    const seed = await seedRequest(2);
    const [t0, t1] = seed.tracks;
    if (t0 === undefined || t1 === undefined) throw new Error('seed too small');

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId, t1.relationshipId],
      })
    );
    await requestSharedFilesRepository.revokeGrant({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      relationshipId: t1.relationshipId,
      actorUserId: seed.clientUserId,
    });

    const found = await requestSharedFilesRepository.findByIdInRequest(
      file.id,
      seed.projectRequestId
    );
    expect(found?.grants.map((g) => g.relationshipId)).toEqual([t0.relationshipId]);
  });

  /**
   * ⚠ THE GROUPING MUST ACCUMULATE, NOT OVERWRITE. Grants are read in one flat query and then
   * bucketed per file; a bucket that replaces rather than appends would silently report a file
   * shared with three experts as shared with ONE — under-reporting an access boundary on the
   * exact screen the client uses to audit it. Two grants on ONE file is the smallest case that
   * distinguishes the two implementations.
   */
  it('groups EVERY live grant onto its file, not just the first', async () => {
    const seed = await seedRequest(3);
    const [t0, t1, t2] = seed.tracks;
    if (t0 === undefined || t1 === undefined || t2 === undefined) throw new Error('seed too small');

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId, t1.relationshipId, t2.relationshipId],
      })
    );

    const found = await requestSharedFilesRepository.findByIdInRequest(
      file.id,
      seed.projectRequestId
    );
    expect(found?.grants.map((g) => g.relationshipId).sort()).toEqual(
      [t0.relationshipId, t1.relationshipId, t2.relationshipId].sort()
    );

    // And through the list read, which uses the same grouping helper.
    const listed = await requestSharedFilesRepository.listForRequest(seed.projectRequestId);
    expect(listed.find((r) => r.file.id === file.id)?.grants).toHaveLength(3);
  });
});

describe('requestSharedFilesRepository.listForRequest', () => {
  it('lists live files oldest-first with their live grants, and hides tombstones', async () => {
    const seed = await seedRequest(2);
    const [t0] = seed.tracks;
    if (t0 === undefined) throw new Error('seed too small');

    const first = await requestSharedFilesRepository.share(shareInput(seed, { fileName: 'a.pdf' }));
    await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'b.pdf',
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId],
      })
    );
    await requestSharedFilesRepository.softDelete({
      fileId: first.file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: seed.clientUserId,
    });

    const live = await requestSharedFilesRepository.listForRequest(seed.projectRequestId);
    expect(live.map((f) => f.file.fileName)).toEqual(['b.pdf']);
    expect(live[0]?.grants).toHaveLength(1);

    const all = await requestSharedFilesRepository.listForRequest(seed.projectRequestId, {
      includeDeleted: true,
    });
    expect(all.map((f) => f.file.fileName).sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('scopes strictly to its request', async () => {
    const seedX = await seedRequest(1);
    const seedY = await seedRequest(1);
    await requestSharedFilesRepository.share(shareInput(seedX));

    await expect(
      requestSharedFilesRepository.listForRequest(seedY.projectRequestId)
    ).resolves.toEqual([]);
  });
});

// ── revokeGrant + softDelete ───────────────────────────────────────────

describe('requestSharedFilesRepository.revokeGrant', () => {
  it('soft-deletes exactly one grant and records the revoker', async () => {
    const seed = await seedRequest(2);
    const [t0, t1] = seed.tracks;
    if (t0 === undefined || t1 === undefined) throw new Error('seed too small');
    const revoker = await userFactory();

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId, t1.relationshipId],
      })
    );

    const revoked = await requestSharedFilesRepository.revokeGrant({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      relationshipId: t0.relationshipId,
      actorUserId: revoker.id,
    });

    expect(revoked.deletedAt).not.toBeNull();
    // RULING 3 — the revoker is party-level and is frequently NOT the granter. Both survive.
    expect(revoked.revokedByUserId).toBe(revoker.id);
    expect(revoked.grantedByUserId).toBe(seed.clientUserId);

    const remaining = await db
      .select()
      .from(requestFileGrants)
      .where(
        and(
          eq(requestFileGrants.fileId, file.id),
          eq(requestFileGrants.relationshipId, t1.relationshipId)
        )
      );
    expect(remaining[0]?.deletedAt).toBeNull();
  });

  it('is not idempotent by silence — a second revoke throws', async () => {
    const seed = await seedRequest(1);
    const [t0] = seed.tracks;
    if (t0 === undefined) throw new Error('seed too small');
    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, { audience: 'grants', grantRelationshipIds: [t0.relationshipId] })
    );
    const input = {
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      relationshipId: t0.relationshipId,
      actorUserId: seed.clientUserId,
    };
    await requestSharedFilesRepository.revokeGrant(input);

    await expect(requestSharedFilesRepository.revokeGrant(input)).rejects.toBeInstanceOf(
      RequestFileGrantNotFoundError
    );
  });

  it('refuses to revoke through a FOREIGN request id (containment)', async () => {
    const seedX = await seedRequest(1);
    const seedY = await seedRequest(1);
    const [t0] = seedX.tracks;
    if (t0 === undefined) throw new Error('seed too small');
    const { file } = await requestSharedFilesRepository.share(
      shareInput(seedX, { audience: 'grants', grantRelationshipIds: [t0.relationshipId] })
    );

    await expect(
      requestSharedFilesRepository.revokeGrant({
        fileId: file.id,
        projectRequestId: seedY.projectRequestId,
        relationshipId: t0.relationshipId,
        actorUserId: seedY.clientUserId,
      })
    ).rejects.toBeInstanceOf(RequestFileNotFoundError);
  });
});

describe('requestSharedFilesRepository.softDelete', () => {
  it('tombstones the row, records the deleter, and hands back the r2Key for the caller', async () => {
    const seed = await seedRequest(2);
    const deleter = await userFactory();
    const key = freshR2Key(seed.projectRequestId, seed.clientUserId);
    const { file } = await requestSharedFilesRepository.share(shareInput(seed, { r2Key: key }));

    const result = await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: deleter.id,
    });

    expect(result.file.deletedAt).not.toBeNull();
    // RULING 3: uploader AND deleter are both preserved.
    expect(result.file.deletedByUserId).toBe(deleter.id);
    expect(result.file.uploadedByUserId).toBe(seed.clientUserId);
    // ⚠ The caller performs the best-effort R2 delete AFTER commit — never in-transaction.
    expect(result.r2Key).toBe(key);
    expect(result.resolvedAudience.map((e) => e.relationshipId).sort()).toEqual(
      seed.tracks.map((t) => t.relationshipId).sort()
    );
  });

  it('throws on a second delete and on a foreign request id', async () => {
    const seedX = await seedRequest(1);
    const seedY = await seedRequest(1);
    const { file } = await requestSharedFilesRepository.share(shareInput(seedX));

    await expect(
      requestSharedFilesRepository.softDelete({
        fileId: file.id,
        projectRequestId: seedY.projectRequestId,
        actorUserId: seedY.clientUserId,
      })
    ).rejects.toBeInstanceOf(RequestFileNotFoundError);

    await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seedX.projectRequestId,
      actorUserId: seedX.clientUserId,
    });
    await expect(
      requestSharedFilesRepository.softDelete({
        fileId: file.id,
        projectRequestId: seedX.projectRequestId,
        actorUserId: seedX.clientUserId,
      })
    ).rejects.toBeInstanceOf(RequestFileAlreadyDeletedError);
  });

  it('leaves live grant rows intact — the file’s own tombstone closes visibility', async () => {
    const seed = await seedRequest(1);
    const [t0] = seed.tracks;
    if (t0 === undefined) throw new Error('seed too small');
    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, { audience: 'grants', grantRelationshipIds: [t0.relationshipId] })
    );

    await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: seed.clientUserId,
    });

    const grants = await db
      .select()
      .from(requestFileGrants)
      .where(eq(requestFileGrants.fileId, file.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.deletedAt).toBeNull();
  });
});

// ── ADR-1048 §7 invariant 3: the audit contract ────────────────────────

describe('audit_events participate in the SAME transaction (ADR-1030 / invariant 3)', () => {
  it.each(['all_live_tracks', 'grants', 'revoke', 'delete'] as const)(
    'writes no audit row when the caller transaction rolls back: %s',
    async (mode) => {
      const seed = await seedRequest(2);
      const [t0] = seed.tracks;
      if (t0 === undefined) throw new Error('seed too small');

      // Revoke and delete need a committed file to act on.
      const existing =
        mode === 'revoke' || mode === 'delete'
          ? await requestSharedFilesRepository.share(
              shareInput(seed, {
                audience: 'grants',
                grantRelationshipIds: [t0.relationshipId],
              })
            )
          : undefined;
      const fileId = existing?.file.id;
      const auditBefore = fileId === undefined ? [] : await auditRowsFor(fileId);

      await expect(
        db.transaction(async (tx) => {
          if (mode === 'all_live_tracks') {
            await requestSharedFilesRepository.share(shareInput(seed), tx);
          } else if (mode === 'grants') {
            await requestSharedFilesRepository.share(
              shareInput(seed, {
                audience: 'grants',
                grantRelationshipIds: [t0.relationshipId],
              }),
              tx
            );
          } else if (mode === 'revoke') {
            await requestSharedFilesRepository.revokeGrant(
              {
                fileId: fileId ?? '',
                projectRequestId: seed.projectRequestId,
                relationshipId: t0.relationshipId,
                actorUserId: seed.clientUserId,
              },
              tx
            );
          } else {
            await requestSharedFilesRepository.softDelete(
              {
                fileId: fileId ?? '',
                projectRequestId: seed.projectRequestId,
                actorUserId: seed.clientUserId,
              },
              tx
            );
          }
          throw new Error('force rollback');
        })
      ).rejects.toThrow('force rollback');

      if (fileId === undefined) {
        // A rolled-back share leaves no file, so nothing anywhere references it.
        const stray = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.entityType, 'request_shared_file'));
        expect(stray.filter((r) => r.action.startsWith('request_shared_file.'))).toHaveLength(0);
      } else {
        expect(await auditRowsFor(fileId)).toEqual(auditBefore);
      }
    }
  );
});

/**
 * ⚠⚠ RULING 4'S PAYLOAD CONTRACT, KEY BY KEY. `audit_events` is APPEND-ONLY — no
 * `updated_at`, no `deleted_at`, no backfill — so a wrong shape here is UNRECOVERABLE.
 * These assertions use exact `toEqual` on the whole `metadata` object, deliberately: an
 * ADDED key is a contract change and must fail here rather than ship silently.
 */
describe('the audit payload contract (Ruling 4 — append-only, no backfill)', () => {
  it('shared_all_tracks: common keys + the resolved live set at share time', async () => {
    const seed = await seedRequest(2);
    const { file, resolvedLiveTracks } = await requestSharedFilesRepository.share(
      shareInput(seed, { fileName: 'brief.pdf' })
    );

    const rows = await auditRowsFor(file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('request_shared_file.shared_all_tracks');
    expect(rows[0]?.entityType).toBe('request_shared_file');
    expect(rows[0]?.actorUserId).toBe(seed.clientUserId);
    expect(rows[0]?.metadata).toEqual({
      projectRequestId: seed.projectRequestId,
      fileName: 'brief.pdf',
      side: 'client',
      audience: 'all_live_tracks',
      resolvedLiveTracks: resolvedLiveTracks.map((e) => ({
        relationshipId: e.relationshipId,
        expertProfileId: e.expertProfileId,
      })),
    });
  });

  it('grant_added: ONE row per grant, each naming the track AND its expert profile', async () => {
    const seed = await seedRequest(3);
    const [t0, t1] = seed.tracks;
    if (t0 === undefined || t1 === undefined) throw new Error('seed too small');

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'scope.pdf',
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId, t1.relationshipId],
      })
    );

    const rows = await auditRowsFor(file.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === 'request_shared_file.grant_added')).toBe(true);

    const payloads = rows
      .map((r) => r.metadata as Record<string, unknown>)
      .sort((a, b) => String(a.relationshipId).localeCompare(String(b.relationshipId)));
    const expected = [t0, t1]
      .map((t) => ({
        projectRequestId: seed.projectRequestId,
        fileName: 'scope.pdf',
        side: 'client',
        audience: 'grants',
        relationshipId: t.relationshipId,
        expertProfileId: t.expertProfileId,
      }))
      .sort((a, b) => a.relationshipId.localeCompare(b.relationshipId));
    expect(payloads).toEqual(expected);
  });

  it('grant_revoked: the track, its expert profile, the grant id and when it was granted', async () => {
    const seed = await seedRequest(1);
    const [t0] = seed.tracks;
    if (t0 === undefined) throw new Error('seed too small');
    const revoker = await userFactory();

    const { file, grants } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'scope.pdf',
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId],
      })
    );
    const [grant] = grants;
    if (grant === undefined) throw new Error('no grant written');

    await requestSharedFilesRepository.revokeGrant({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      relationshipId: t0.relationshipId,
      actorUserId: revoker.id,
    });

    const rows = await auditRowsFor(file.id);
    const revoked = rows.find((r) => r.action === 'request_shared_file.grant_revoked');
    expect(revoked?.actorUserId).toBe(revoker.id);
    expect(revoked?.metadata).toEqual({
      projectRequestId: seed.projectRequestId,
      fileName: 'scope.pdf',
      side: 'client',
      audience: 'grants',
      relationshipId: t0.relationshipId,
      expertProfileId: t0.expertProfileId,
      grantId: grant.id,
      grantedAtIso: grant.createdAt.toISOString(),
    });
  });

  /**
   * ⚠ RULING 1'S WHOLE JUSTIFICATION. The R2 object IS deleted, so this row plus the
   * tombstone are the ONLY remaining answer to "who had access to what, when".
   */
  it('deleted: the resolved audience at delete time PLUS the file metadata', async () => {
    const seed = await seedRequest(2);
    const [t0, t1] = seed.tracks;
    if (t0 === undefined || t1 === undefined) throw new Error('seed too small');
    const deleter = await userFactory();
    const key = freshR2Key(seed.projectRequestId, seed.clientUserId);

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'scope.pdf',
        r2Key: key,
        audience: 'grants',
        grantRelationshipIds: [t0.relationshipId],
      })
    );

    const result = await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: deleter.id,
    });

    const rows = await auditRowsFor(file.id);
    const deleted = rows.find((r) => r.action === 'request_shared_file.deleted');
    expect(deleted?.actorUserId).toBe(deleter.id);
    expect(deleted?.metadata).toEqual({
      projectRequestId: seed.projectRequestId,
      fileName: 'scope.pdf',
      side: 'client',
      audience: 'grants',
      resolvedAudienceAtDelete: [
        { relationshipId: t0.relationshipId, expertProfileId: t0.expertProfileId, via: 'grant' },
      ],
      contentType: 'application/pdf',
      sizeBytes: 24_576,
      r2Key: key,
      uploadedByUserId: seed.clientUserId,
      createdAtIso: file.createdAt.toISOString(),
    });
    // The returned snapshot and the persisted one are the same set — one function computes both.
    expect(result.resolvedAudience.map((e) => e.relationshipId)).toEqual([t0.relationshipId]);
    // ⚠ NOT the ungranted sibling. A delete snapshot that over-reported would be a false
    // record of who saw a document, and there is no backfill.
    expect(result.resolvedAudience.map((e) => e.relationshipId)).not.toContain(t1.relationshipId);
  });

  /**
   * ⚠ DELIBERATELY UNAUDITED. An expert's own-track upload is not an access-boundary
   * DECISION — the row itself is the complete record and the audience is structurally fixed
   * by the CHECK. Ruling 4 names four actions and this is not one of them.
   */
  it('writes NO audit row for an expert own-track upload', async () => {
    const seed = await seedRequest(1);
    const [own] = seed.tracks;
    if (own === undefined) throw new Error('seed too small');
    const expertUser = await userFactory();

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, {
        uploadedByUserId: expertUser.id,
        side: 'expert',
        audience: 'own_track',
        expertRelationshipId: own.relationshipId,
      })
    );

    expect(await auditRowsFor(file.id)).toEqual([]);
  });
});

// ── §5 promotion lineage ───────────────────────────────────────────────

describe('requestSharedFilesRepository.listForEngagement (§5 lineage — a read-side join)', () => {
  it('returns the winner-visible set: all-tracks shares, own-track files, granted files', async () => {
    const seed = await seedRequest(2);
    const [winner, other] = seed.tracks;
    if (winner === undefined || other === undefined) throw new Error('seed too small');
    const expertUser = await userFactory();

    await requestSharedFilesRepository.share(shareInput(seed, { fileName: 'all.pdf' }));
    await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'granted-to-winner.pdf',
        audience: 'grants',
        grantRelationshipIds: [winner.relationshipId],
      })
    );
    await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'granted-to-other.pdf',
        audience: 'grants',
        grantRelationshipIds: [other.relationshipId],
      })
    );
    await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'winner-own.pdf',
        uploadedByUserId: expertUser.id,
        side: 'expert',
        audience: 'own_track',
        expertRelationshipId: winner.relationshipId,
      })
    );
    // ⚠ THE CROSS-TRACK FILE. A sibling candidate's own upload must never reach the winner.
    await requestSharedFilesRepository.share(
      shareInput(seed, {
        fileName: 'other-own.pdf',
        uploadedByUserId: expertUser.id,
        side: 'expert',
        audience: 'own_track',
        expertRelationshipId: other.relationshipId,
      })
    );

    const { engagement } = await engagementFactory({
      projectValues: {
        projectRequestId: seed.projectRequestId,
        relationshipId: winner.relationshipId,
      },
    });

    const visible = await requestSharedFilesRepository.listForEngagement(engagement.id, {
      companyId: engagement.companyId,
    });
    expect(visible.map((f) => f.file.fileName).sort()).toEqual([
      'all.pdf',
      'granted-to-winner.pdf',
      'winner-own.pdf',
    ]);
  });

  /** ADR-1048 §7 invariant 5 — and it holds BY CONSTRUCTION, not by a filter. */
  it('never follows lineage for a DELETED file', async () => {
    const seed = await seedRequest(1);
    const [winner] = seed.tracks;
    if (winner === undefined) throw new Error('seed too small');

    const { file } = await requestSharedFilesRepository.share(
      shareInput(seed, { fileName: 'gone.pdf' })
    );
    await requestSharedFilesRepository.share(shareInput(seed, { fileName: 'kept.pdf' }));
    await requestSharedFilesRepository.softDelete({
      fileId: file.id,
      projectRequestId: seed.projectRequestId,
      actorUserId: seed.clientUserId,
    });

    const { engagement } = await engagementFactory({
      projectValues: {
        projectRequestId: seed.projectRequestId,
        relationshipId: winner.relationshipId,
      },
    });

    const visible = await requestSharedFilesRepository.listForEngagement(engagement.id, {
      companyId: engagement.companyId,
    });
    expect(visible.map((f) => f.file.fileName)).toEqual(['kept.pdf']);
  });

  it('fails closed to [] with no lineage, an unknown engagement, or a withdrawn track', async () => {
    await expect(
      requestSharedFilesRepository.listForEngagement(randomUUID(), { companyId: randomUUID() })
    ).resolves.toEqual([]);

    // No origination row at all (the retainer seam).
    const bare = await engagementFactory();
    await expect(
      requestSharedFilesRepository.listForEngagement(bare.engagement.id, {
        companyId: bare.engagement.companyId,
      })
    ).resolves.toEqual([]);

    // Lineage present, but the originating track has been withdrawn (soft-deleted).
    const seed = await seedRequest(1);
    const [winner] = seed.tracks;
    if (winner === undefined) throw new Error('seed too small');
    await requestSharedFilesRepository.share(shareInput(seed));
    const { engagement } = await engagementFactory({
      projectValues: {
        projectRequestId: seed.projectRequestId,
        relationshipId: winner.relationshipId,
      },
    });
    await closeTrack(winner.relationshipId, 'withdrawn');

    await expect(
      requestSharedFilesRepository.listForEngagement(engagement.id, {
        companyId: engagement.companyId,
      })
    ).resolves.toEqual([]);
  });
});
