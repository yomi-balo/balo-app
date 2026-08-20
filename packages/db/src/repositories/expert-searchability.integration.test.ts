import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import {
  auditEvents,
  expertPayoutDetails,
  expertProfiles,
  CALENDAR_CREDENTIAL_STATUSES,
  type CalendarCredentialStatus,
} from '../schema';
import { hasLiveCalendarConnection, deriveExpertChecklist } from '@balo/shared/experts';
import { expertDraftFactory, userFactory } from '../test/factories';
import { availabilityRulesRepository } from './availability-rules';
import { calendarRepository } from './calendar';
import { payoutsRepository } from './payouts';
import { usersRepository } from './users';
import {
  expertSearchabilityRepository,
  EXPERT_SEARCHABILITY_AUDIT_ENTITY_TYPE,
  EXPERT_SEARCHABILITY_GRANTED_ACTION,
  EXPERT_SEARCHABILITY_REVOKED_ACTION,
  type ExpertSearchabilitySnapshot,
} from './expert-searchability';

/**
 * BAL-414 — `expertSearchabilityRepository` against REAL Postgres.
 *
 * ⚠⚠ THIS SUITE IS NOT A COVERAGE CHECKBOX. It is the ONLY gate in the repository that can
 * catch these failure modes, every one of which leaves typecheck, lint AND a mocked unit test
 * green:
 *
 *   · **D4 ANY-ACTIVE collapsing back to one row.** Connections are per-(expert, provider)
 *     since BAL-467. If the read ever narrows to "the expert's connection", an expert holding
 *     an EXPIRED Google and a healthy Microsoft reads `calendar: false` — and under symmetric
 *     revocation that is a WRONGFUL DE-LISTING that also 404s their public profile page. Only
 *     real rows in a real table can prove the array is the whole live set.
 *
 *   · **A soft-deleted connection resurrecting.** "Disconnected" has TWO representations — a
 *     soft-deleted row AND an EXPIRED/REVOKED row — and they are handled in two different
 *     places (SQL filter vs. the shared rule). A dropped `deleted_at IS NULL` keeps a
 *     disconnected expert listed and bookable.
 *
 *   · **The conditional compare-and-set degrading into an unconditional write.** `searchable`
 *     now has two writers. Lose the `searchable <> $1` predicate and `changed` is true on
 *     every call, which means a duplicate `audit_events` row, a duplicate notification and a
 *     duplicate analytics event on every retried job and every dashboard render.
 *
 *   · **The audit row escaping the transaction.** A crash between the boolean flip and the
 *     audit append leaves an unexplainable de-listing.
 *
 *   · **PII over-hydration.** A relational `with:` would pull `users.workos_id` / `email` into
 *     a value that flows into an RSC render tree.
 *
 * ⚠ WHAT THIS HARNESS CANNOT PROVE: genuine concurrency. Every test runs inside ONE
 * transaction on a `max: 1` pool, so two racing writers are inexpressible here. The
 * compare-and-set RACE argument is documented in the repository docblock; what is asserted
 * below is its single-writer consequence — a redundant write is a no-op with no audit row.
 *
 * ⚠ Docker-down does NOT silently pass: `global-setup.ts` throws and the process exits 1.
 * Still check the test COUNT, not just the exit code — a 0-exit with 0 tests run is the shape
 * a regression in the HARNESS itself would take.
 */

// ── Fixtures ──────────────────────────────────────────────────────

/** Seed one live connection for `(expert, provider)` at the given credential status. */
async function connect(
  expertProfileId: string,
  provider: string,
  credentialStatus: CalendarCredentialStatus = 'ACTIVE'
): Promise<{ id: string }> {
  const row = await calendarRepository.upsertApirocConnection({
    expertProfileId,
    provider,
    endUserAccountId: `eua_${provider}_${expertProfileId}`,
    providerEmail: `expert@${provider}.example`,
    credentialStatus,
  });
  return { id: row.id };
}

/** Satisfy the `payouts` checklist item. */
async function addPayoutDetails(expertProfileId: string): Promise<void> {
  await payoutsRepository.upsertPayoutDetails(expertProfileId, {
    countryCode: 'AU',
    currency: 'AUD',
    transferMethod: 'LOCAL',
    entityType: 'PERSONAL',
    formValues: { account_name: 'Test Expert' },
  });
}

/** Satisfy the `availability` checklist item. */
async function addWeeklyRule(expertProfileId: string): Promise<void> {
  await availabilityRulesRepository.replaceForExpert(expertProfileId, [
    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
  ]);
}

/** `loadInputs`, with the `undefined` arm narrowed away so tests read cleanly. */
async function loadOrFail(expertProfileId: string): Promise<ExpertSearchabilitySnapshot> {
  const snapshot = await expertSearchabilityRepository.loadInputs(expertProfileId);
  if (snapshot === undefined) throw new Error(`no snapshot for ${expertProfileId}`);
  return snapshot;
}

/**
 * The D4 rule, expressed here as an ASSERTION over what the read returned — never as a second
 * definition of it (BLOCKER 5, fix round 1). This calls the SAME shared rule production code
 * uses (`hasLiveCalendarConnection` in `@balo/shared/experts`) rather than re-implementing the
 * `'ACTIVE'` comparison locally: a local re-implementation would drift in lockstep with the
 * production bug this test exists to catch (a DB vocabulary rename), so a rename would make
 * BOTH sides evaluate false and this test would still pass while the real rule silently
 * de-lists every expert on the platform. Importing the rule closes that hole; the anchor test
 * below (`CALENDAR_CREDENTIAL_STATUSES` contains `'ACTIVE'`) pins the OTHER half — that the
 * literal itself still exists in the vocabulary.
 */
function anyConnectionActive(snapshot: ExpertSearchabilitySnapshot): boolean {
  return hasLiveCalendarConnection(snapshot.inputs.calendarConnections);
}

async function auditRowsFor(expertProfileId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, EXPERT_SEARCHABILITY_AUDIT_ENTITY_TYPE),
        eq(auditEvents.entityId, expertProfileId)
      )
    );
}

async function readSearchable(expertProfileId: string): Promise<boolean> {
  const rows = await db
    .select({ searchable: expertProfiles.searchable })
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId));
  const [row] = rows;
  if (row === undefined) throw new Error(`no expert_profiles row for ${expertProfileId}`);
  return row.searchable;
}

// ── loadInputs: not-found ─────────────────────────────────────────

describe('expertSearchabilityRepository.loadInputs — not found', () => {
  it('returns undefined for an unknown expert profile id', async () => {
    await expect(expertSearchabilityRepository.loadInputs(randomUUID())).resolves.toBeUndefined();
  });

  /**
   * ⚠⚠ S1 (fix round 1) — REVERSED from the pre-fix-round behaviour. `expert_profiles` has no
   * `deleted_at` column, so there is nothing to guard on the profile itself; the `users` join
   * is where soft-delete used to enter (`isNull(users.deletedAt)`), which meant a soft-deleted
   * user matched ZERO rows and this returned `undefined` — indistinguishable from "profile does
   * not exist" and, worse, unreachable by `deriveExpertChecklist`, which is exactly the
   * structural hole S1 closes: the reconciler could never de-list the one class of expert that
   * most obviously must be de-listed. The join no longer filters `deleted_at`, so a soft-deleted
   * user's row now comes back DEFINED, with `userDeletedAt` populated for the derivation to act
   * on (see the S1 describe block below for the full de-list assertion).
   */
  it('returns a DEFINED snapshot, with userDeletedAt populated, when the user row is soft-deleted', async () => {
    const user = await userFactory({ avatarUrl: 'https://cdn.test/a.png' });
    const expert = await expertDraftFactory({ userId: user.id });
    await expect(expertSearchabilityRepository.loadInputs(expert.id)).resolves.toBeDefined();

    await usersRepository.softDelete(user.id);

    const snapshot = await loadOrFail(expert.id);
    expect(snapshot.inputs.userDeletedAt).toBeInstanceOf(Date);
  });
});

// ── S1: a soft-deleted user is de-listed end-to-end ───────────────

describe('S1 (fix round 1) — a soft-deleted user is de-listed, not skipped', () => {
  it('de-lists an otherwise-complete expert once their user row is soft-deleted', async () => {
    const user = await userFactory({
      avatarUrl: 'https://cdn.test/a.png',
      phoneVerifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const expert = await expertDraftFactory({ userId: user.id });
    await db
      .update(expertProfiles)
      .set({ headline: 'Architect', bio: 'CPQ.', rateCents: 20_000 })
      .where(eq(expertProfiles.id, expert.id));
    await connect(expert.id, 'google', 'ACTIVE');
    await addWeeklyRule(expert.id);
    await addPayoutDetails(expert.id);

    const beforeDelete = deriveExpertChecklist((await loadOrFail(expert.id)).inputs);
    expect(beforeDelete.allComplete).toBe(true);

    await usersRepository.softDelete(user.id);

    const afterDelete = deriveExpertChecklist((await loadOrFail(expert.id)).inputs);
    expect(afterDelete.allComplete).toBe(false);
    // The six-item vocabulary itself is untouched by the account-deletion state — only
    // `allComplete` moves, per S1's docblock in `checklist.ts`.
    expect(afterDelete.failingItems).toEqual([]);

    await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: afterDelete.allComplete,
      actorUserId: null,
      source: 'dashboard_read',
      failingItems: afterDelete.failingItems,
    });
    expect(await readSearchable(expert.id)).toBe(false);
  });
});

// ── loadInputs: the projection ────────────────────────────────────

describe('expertSearchabilityRepository.loadInputs — projection', () => {
  it('returns every checklist input in one read, with the profile/user columns joined', async () => {
    const verifiedAt = new Date('2026-08-01T00:00:00.000Z');
    const user = await userFactory({
      avatarUrl: 'https://cdn.test/avatar.png',
      phoneVerifiedAt: verifiedAt,
    });
    const expert = await expertDraftFactory({ userId: user.id });
    await db
      .update(expertProfiles)
      .set({ headline: 'Salesforce architect', bio: 'Ten years of CPQ.', rateCents: 25_000 })
      .where(eq(expertProfiles.id, expert.id));
    await connect(expert.id, 'google');
    await addWeeklyRule(expert.id);
    await addPayoutDetails(expert.id);

    const snapshot = await loadOrFail(expert.id);

    expect(snapshot.inputs.headline).toBe('Salesforce architect');
    expect(snapshot.inputs.bio).toBe('Ten years of CPQ.');
    expect(snapshot.inputs.avatarUrl).toBe('https://cdn.test/avatar.png');
    expect(snapshot.inputs.phoneVerifiedAt?.toISOString()).toBe(verifiedAt.toISOString());
    expect(snapshot.inputs.rateCents).toBe(25_000);
    expect(snapshot.inputs.hasActiveAvailabilityRules).toBe(true);
    expect(snapshot.inputs.hasPayoutDetails).toBe(true);
    expect(anyConnectionActive(snapshot)).toBe(true);
    expect(snapshot.currentSearchable).toBe(false);
    expect(snapshot.rateCents).toBe(25_000);
  });

  it('returns the empty-checklist shape for a bare expert (no nulls-as-crashes)', async () => {
    const expert = await expertDraftFactory();

    const snapshot = await loadOrFail(expert.id);

    expect(snapshot.inputs.headline).toBeNull();
    expect(snapshot.inputs.bio).toBeNull();
    expect(snapshot.inputs.avatarUrl).toBeNull();
    expect(snapshot.inputs.phoneVerifiedAt).toBeNull();
    expect(snapshot.inputs.rateCents).toBeNull();
    // COALESCE, not NULL — the rule takes an array and must never null-check.
    expect(snapshot.inputs.calendarConnections).toEqual([]);
    expect(snapshot.inputs.hasActiveAvailabilityRules).toBe(false);
    expect(snapshot.inputs.hasPayoutDetails).toBe(false);
  });

  /**
   * ⚠ GUARDS `reference_drizzle_with_hydration_leaks_secrets`. A relational `with:` would
   * hydrate the FULL `users` row into a value that flows into an RSC render tree. Asserted on
   * the serialised snapshot so a nested leak anywhere in the object fails too.
   */
  it('over-hydrates nothing — no workosId, email or phone reaches the caller', async () => {
    const user = await userFactory({ avatarUrl: 'https://cdn.test/a.png' });
    const expert = await expertDraftFactory({ userId: user.id });

    const snapshot = await loadOrFail(expert.id);

    const serialised = JSON.stringify(snapshot);
    expect(serialised).not.toContain('workosId');
    expect(serialised).not.toContain('email');
    expect(serialised).not.toContain(user.email);
    expect(serialised).not.toContain(user.workosId);
    expect(Object.keys(snapshot.inputs).sort()).toEqual([
      'avatarUrl',
      'bio',
      'calendarConnections',
      'hasActiveAvailabilityRules',
      'hasPayoutDetails',
      'headline',
      'phoneVerifiedAt',
      'rateCents',
      'userDeletedAt',
    ]);
  });

  it('scopes every correlated subquery to the expert under read', async () => {
    const mine = await expertDraftFactory();
    const theirs = await expertDraftFactory();
    await connect(theirs.id, 'google');
    await addWeeklyRule(theirs.id);
    await addPayoutDetails(theirs.id);

    const snapshot = await loadOrFail(mine.id);

    expect(snapshot.inputs.calendarConnections).toEqual([]);
    expect(snapshot.inputs.hasActiveAvailabilityRules).toBe(false);
    expect(snapshot.inputs.hasPayoutDetails).toBe(false);
  });

  it('ignores soft-deleted availability rules and soft-deleted payout details', async () => {
    const expert = await expertDraftFactory();
    await addWeeklyRule(expert.id);
    await addPayoutDetails(expert.id);
    expect((await loadOrFail(expert.id)).inputs.hasActiveAvailabilityRules).toBe(true);

    await availabilityRulesRepository.deleteAllForExpert(expert.id);
    // `payoutsRepository` exposes no soft-delete today, so stamp the column directly — the
    // point under test is the repository's `deleted_at IS NULL` filter, not how a row got
    // stamped.
    await db
      .update(expertPayoutDetails)
      .set({ deletedAt: new Date() })
      .where(eq(expertPayoutDetails.expertProfileId, expert.id));

    const snapshot = await loadOrFail(expert.id);
    expect(snapshot.inputs.hasActiveAvailabilityRules).toBe(false);
    expect(snapshot.inputs.hasPayoutDetails).toBe(false);
  });
});

// ── loadInputs: D4, the calendar half ─────────────────────────────

describe('expertSearchabilityRepository.loadInputs — D4 ANY-ACTIVE over the connection SET', () => {
  /**
   * ⚠⚠ THE TEST BAL-414 EXISTS FOR. `findConnectionByExpertProfileId` returns the OLDEST live
   * connection, so reading through it here would answer EXPIRED for this expert and de-list
   * someone whose Microsoft calendar is perfectly healthy — removing them from search AND
   * 404ing their public profile URL.
   */
  it('returns BOTH providers when Google is EXPIRED and Microsoft is ACTIVE', async () => {
    const expert = await expertDraftFactory();
    const google = await connect(expert.id, 'google', 'ACTIVE');
    const microsoft = await connect(expert.id, 'microsoft', 'ACTIVE');
    // Break the OLDER one — the row a single-connection read would have picked.
    await calendarRepository.setCredentialStatus(google.id, 'EXPIRED');

    const snapshot = await loadOrFail(expert.id);

    expect(snapshot.inputs.calendarConnections).toHaveLength(2);
    expect(
      snapshot.inputs.calendarConnections.find((c) => c.id === google.id)?.credentialStatus
    ).toBe('EXPIRED');
    expect(
      snapshot.inputs.calendarConnections.find((c) => c.id === microsoft.id)?.credentialStatus
    ).toBe('ACTIVE');
    expect(anyConnectionActive(snapshot)).toBe(true);
  });

  it('has no ACTIVE connection when every live connection is broken', async () => {
    const expert = await expertDraftFactory();
    const google = await connect(expert.id, 'google');
    const microsoft = await connect(expert.id, 'microsoft');
    await calendarRepository.setCredentialStatus(google.id, 'EXPIRED');
    await calendarRepository.setCredentialStatus(microsoft.id, 'REVOKED');

    const snapshot = await loadOrFail(expert.id);

    expect(snapshot.inputs.calendarConnections).toHaveLength(2);
    expect(anyConnectionActive(snapshot)).toBe(false);
  });

  /**
   * The SECOND representation of "disconnected". A self-disconnect soft-deletes the row rather
   * than moving its status, so a dropped `deleted_at IS NULL` filter keeps the expert listed
   * and bookable on a calendar they unhooked.
   */
  it('excludes a soft-deleted connection even though its credential is still ACTIVE', async () => {
    const expert = await expertDraftFactory();
    const google = await connect(expert.id, 'google', 'ACTIVE');
    expect(anyConnectionActive(await loadOrFail(expert.id))).toBe(true);

    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    const snapshot = await loadOrFail(expert.id);
    expect(snapshot.inputs.calendarConnections).toEqual([]);
    expect(snapshot.inputs.calendarConnections.map((c) => c.id)).not.toContain(google.id);
    expect(anyConnectionActive(snapshot)).toBe(false);
  });

  it('a soft-deleted ACTIVE row cannot rescue a live EXPIRED one', async () => {
    const expert = await expertDraftFactory();
    await connect(expert.id, 'google', 'ACTIVE');
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');
    const microsoft = await connect(expert.id, 'microsoft', 'ACTIVE');
    await calendarRepository.setCredentialStatus(microsoft.id, 'EXPIRED');

    const snapshot = await loadOrFail(expert.id);

    expect(snapshot.inputs.calendarConnections).toHaveLength(1);
    expect(anyConnectionActive(snapshot)).toBe(false);
  });

  /**
   * ⚠ THE CROSS-PACKAGE VOCABULARY PIN (plan T1.5). `@balo/shared` cannot import the column's
   * `$type<>` union, so the rule compares against the string `'ACTIVE'`. This loop is what
   * fails the moment the DB vocabulary renames or drops that value — without it, a rename
   * would leave the rule matching zero rows forever, silently, and de-list every expert.
   */
  it.each(CALENDAR_CREDENTIAL_STATUSES)(
    'round-trips credential status %s, and only ACTIVE satisfies the rule',
    async (status) => {
      const expert = await expertDraftFactory();
      const connection = await connect(expert.id, 'google', status);

      const snapshot = await loadOrFail(expert.id);

      expect(snapshot.inputs.calendarConnections).toEqual([
        { id: connection.id, credentialStatus: status },
      ]);
      expect(anyConnectionActive(snapshot)).toBe(status === 'ACTIVE');
    }
  );

  // BLOCKER 5, fix round 1 — the NON-SYMMETRIC anchor. `it.each` above proves the rule agrees
  // with itself on every status; it says nothing about whether `'ACTIVE'` is still a real
  // member of the DB vocabulary. Without this, a rename that dropped `'ACTIVE'` from
  // `CALENDAR_CREDENTIAL_STATUSES` entirely would still pass every assertion above (both sides
  // would simply never iterate the renamed value) while silently de-listing every expert on the
  // platform in production.
  it('pins that the vocabulary still contains the literal the rule compares against', () => {
    expect(CALENDAR_CREDENTIAL_STATUSES).toContain('ACTIVE');
  });
});

// ── applySearchable: the conditional compare-and-set ──────────────

describe('expertSearchabilityRepository.applySearchable — the write', () => {
  it('flips false → true, reports the change, and appends exactly one audit row', async () => {
    const expert = await expertDraftFactory();

    const result = await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: true,
      actorUserId: null,
      source: 'calendar_credential_repair',
      failingItems: [],
    });

    expect(result.changed).toBe(true);
    if (!result.changed) throw new Error('expected a change');
    expect(result.previousSearchable).toBe(false);
    expect(result.auditEventId).toBeDefined();
    expect(await readSearchable(expert.id)).toBe(true);

    const rows = await auditRowsFor(expert.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('expected an audit row');
    expect(row.id).toBe(result.auditEventId);
    expect(row.action).toBe(EXPERT_SEARCHABILITY_GRANTED_ACTION);
    expect(row.entityType).toBe('expert_profile');
    expect(row.entityId).toBe(expert.id);
    // ADR-1030's system-actor exemption: a probe heal has no human actor.
    expect(row.actorUserId).toBeNull();
    expect(row.metadata).toEqual({
      source: 'calendar_credential_repair',
      failingItems: [],
      previousSearchable: false,
    });
  });

  it('flips true → false, records the revoke action, the human actor and the failing items', async () => {
    const actor = await userFactory();
    const expert = await expertDraftFactory();
    await db
      .update(expertProfiles)
      .set({ searchable: true })
      .where(eq(expertProfiles.id, expert.id));

    const result = await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: false,
      actorUserId: actor.id,
      source: 'dashboard_read',
      failingItems: ['calendar', 'payouts'],
    });

    expect(result.changed).toBe(true);
    if (!result.changed) throw new Error('expected a change');
    expect(result.previousSearchable).toBe(true);
    expect(await readSearchable(expert.id)).toBe(false);

    const rows = await auditRowsFor(expert.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.action).toBe(EXPERT_SEARCHABILITY_REVOKED_ACTION);
    expect(row?.actorUserId).toBe(actor.id);
    expect(row?.metadata).toEqual({
      source: 'dashboard_read',
      failingItems: ['calendar', 'payouts'],
      previousSearchable: true,
    });
  });

  /**
   * ⚠⚠ IDEMPOTENCE, THE `true` DIRECTION. This is what makes a re-rendered dashboard and a
   * retried BullMQ job silent: no row moved, so no audit row, and every downstream effect
   * (notification, analytics) is gated on exactly this flag.
   */
  it('is a no-op when the row already holds the target value (true)', async () => {
    const expert = await expertDraftFactory();
    await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: true,
      actorUserId: null,
      source: 'calendar_connected',
      failingItems: [],
    });
    expect(await auditRowsFor(expert.id)).toHaveLength(1);

    const second = await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: true,
      actorUserId: null,
      source: 'dashboard_read',
      failingItems: [],
    });

    expect(second).toEqual({ changed: false });
    expect(await readSearchable(expert.id)).toBe(true);
    expect(await auditRowsFor(expert.id)).toHaveLength(1);
  });

  it('is a no-op when the row already holds the target value (false)', async () => {
    const expert = await expertDraftFactory();

    const result = await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: false,
      actorUserId: null,
      source: 'calendar_disconnected',
      failingItems: ['calendar'],
    });

    expect(result).toEqual({ changed: false });
    expect(await readSearchable(expert.id)).toBe(false);
    expect(await auditRowsFor(expert.id)).toHaveLength(0);
  });

  it('reports no change for an expert profile that does not exist', async () => {
    const missing = randomUUID();

    const result = await expertSearchabilityRepository.applySearchable({
      expertProfileId: missing,
      searchable: true,
      actorUserId: null,
      source: 'calendar_credential_break',
      failingItems: [],
    });

    expect(result).toEqual({ changed: false });
    expect(await auditRowsFor(missing)).toHaveLength(0);
  });

  it('writes only the targeted expert', async () => {
    const mine = await expertDraftFactory();
    const theirs = await expertDraftFactory();

    await expertSearchabilityRepository.applySearchable({
      expertProfileId: mine.id,
      searchable: true,
      actorUserId: null,
      source: 'calendar_connected',
      failingItems: [],
    });

    expect(await readSearchable(theirs.id)).toBe(false);
    expect(await auditRowsFor(theirs.id)).toHaveLength(0);
  });
});

// ── applySearchable: the transaction boundary ─────────────────────

describe('expertSearchabilityRepository.applySearchable — one transaction', () => {
  /**
   * ⚠⚠ THE BOOLEAN AND ITS AUDIT ROW COMMIT OR ROLL BACK TOGETHER. Without this, a crash
   * between them leaves an unexplainable de-listing — the harm BAL-414 exists to remove,
   * inverted. Nested `db.transaction` is a SAVEPOINT under the harness, so the rollback is
   * contained and the outer per-test transaction survives.
   */
  it('rolls the boolean AND the audit row back together when the caller transaction fails', async () => {
    const expert = await expertDraftFactory();

    await expect(
      db.transaction(async (tx) => {
        const result = await expertSearchabilityRepository.applySearchable(
          {
            expertProfileId: expert.id,
            searchable: true,
            actorUserId: null,
            source: 'calendar_credential_repair',
            failingItems: [],
          },
          tx
        );
        expect(result.changed).toBe(true);
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    expect(await readSearchable(expert.id)).toBe(false);
    expect(await auditRowsFor(expert.id)).toHaveLength(0);
  });

  it('composes under a caller transaction — both writes are visible on commit', async () => {
    const expert = await expertDraftFactory();

    await db.transaction(async (tx) => {
      await expertSearchabilityRepository.applySearchable(
        {
          expertProfileId: expert.id,
          searchable: true,
          actorUserId: null,
          source: 'calendar_connected',
          failingItems: [],
        },
        tx
      );
    });

    expect(await readSearchable(expert.id)).toBe(true);
    expect(await auditRowsFor(expert.id)).toHaveLength(1);
  });

  /**
   * The §B.4 shape end-to-end: the credential flip and the de-list share ONE executor, so a
   * failure after the flip cannot leave an EXPIRED credential on a still-searchable expert.
   */
  it('shares a transaction with the credential flip — neither survives a rollback', async () => {
    const expert = await expertDraftFactory();
    const google = await connect(expert.id, 'google', 'ACTIVE');
    await db
      .update(expertProfiles)
      .set({ searchable: true })
      .where(eq(expertProfiles.id, expert.id));

    await expect(
      db.transaction(async (tx) => {
        await calendarRepository.setCredentialStatus(google.id, 'EXPIRED', tx);
        await expertSearchabilityRepository.applySearchable(
          {
            expertProfileId: expert.id,
            searchable: false,
            actorUserId: null,
            source: 'calendar_credential_break',
            failingItems: ['calendar'],
          },
          tx
        );
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const snapshot = await loadOrFail(expert.id);
    expect(anyConnectionActive(snapshot)).toBe(true);
    expect(snapshot.currentSearchable).toBe(true);
    expect(await auditRowsFor(expert.id)).toHaveLength(0);
  });

  it('loadInputs reads through a supplied executor and sees that transaction’s writes', async () => {
    const expert = await expertDraftFactory();
    const google = await connect(expert.id, 'google', 'ACTIVE');

    await db.transaction(async (tx) => {
      await calendarRepository.setCredentialStatus(google.id, 'REVOKED', tx);

      const inTx = await expertSearchabilityRepository.loadInputs(expert.id, tx);
      if (inTx === undefined) throw new Error('expected a snapshot');
      expect(inTx.inputs.calendarConnections).toEqual([
        { id: google.id, credentialStatus: 'REVOKED' },
      ]);
    });
  });
});

// ── The connection between the two halves ─────────────────────────

describe('expertSearchabilityRepository — read then write', () => {
  /**
   * The full BAL-414 arc on one expert: complete → listed → calendar breaks → de-listed →
   * calendar heals → re-listed, with one audit row per genuine transition and none for the
   * redundant reconciles in between.
   */
  it('records exactly one audit row per genuine transition across a break/heal cycle', async () => {
    const user = await userFactory({
      avatarUrl: 'https://cdn.test/a.png',
      phoneVerifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const expert = await expertDraftFactory({ userId: user.id });
    await db
      .update(expertProfiles)
      .set({ headline: 'Architect', bio: 'CPQ.', rateCents: 20_000 })
      .where(eq(expertProfiles.id, expert.id));
    const google = await connect(expert.id, 'google', 'ACTIVE');
    await addWeeklyRule(expert.id);
    await addPayoutDetails(expert.id);

    // Complete → listed.
    expect(anyConnectionActive(await loadOrFail(expert.id))).toBe(true);
    await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: true,
      actorUserId: null,
      source: 'calendar_connected',
      failingItems: [],
    });

    // A second reconcile on an unchanged state writes nothing.
    await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: true,
      actorUserId: null,
      source: 'dashboard_read',
      failingItems: [],
    });
    expect(await auditRowsFor(expert.id)).toHaveLength(1);

    // The credential breaks → de-listed.
    await calendarRepository.setCredentialStatus(google.id, 'EXPIRED');
    expect(anyConnectionActive(await loadOrFail(expert.id))).toBe(false);
    await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: false,
      actorUserId: null,
      source: 'calendar_credential_break',
      failingItems: ['calendar'],
    });
    expect(await readSearchable(expert.id)).toBe(false);

    // It heals → re-listed.
    await calendarRepository.setCredentialStatus(google.id, 'ACTIVE');
    expect(anyConnectionActive(await loadOrFail(expert.id))).toBe(true);
    await expertSearchabilityRepository.applySearchable({
      expertProfileId: expert.id,
      searchable: true,
      actorUserId: null,
      source: 'calendar_credential_repair',
      failingItems: [],
    });

    expect(await readSearchable(expert.id)).toBe(true);
    const actions = (await auditRowsFor(expert.id)).map((r) => r.action).sort();
    expect(actions).toEqual([
      EXPERT_SEARCHABILITY_GRANTED_ACTION,
      EXPERT_SEARCHABILITY_GRANTED_ACTION,
      EXPERT_SEARCHABILITY_REVOKED_ACTION,
    ]);
  });
});
