import { describe, it, expect } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { calendarConnections, type CalendarConnection } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { calendarRepository, type UpsertApirocConnectionInput } from './calendar';

/**
 * BAL-467 + BAL-396 — `calendar_connections` against REAL Postgres.
 *
 * ADR-1021, amendment 18 Aug 2026 §1: "A calendar connection is per (expert, provider) …
 * unique on `(expertId, provider)`. An expert may hold connections to multiple providers
 * at once … connect, disconnect, and reconnect are per-provider."
 *
 * ⚠⚠ THIS SUITE IS NOT A COVERAGE CHECKBOX. It is the ONLY gate in the repository that can
 * catch these failure modes, every one of which leaves typecheck, lint AND the mocked unit
 * test green:
 *
 *   · **42P10** — `cal_conn_expert_provider_idx` is PARTIAL, so `upsertApirocConnection`'s
 *     ON CONFLICT arbiter must name `provider` AND restate `targetWhere`. Omit either and
 *     arbiter inference fails AT PLAN TIME: the FIRST upsert on an EMPTY table raises "no
 *     unique or exclusion constraint matching the ON CONFLICT specification".
 *     `calendar.test.ts` cannot see it — it mocks the Drizzle client, so
 *     `onConflictDoUpdate` merely records its argument and never reaches a planner. This is
 *     the live calendar connect path; a break here is a production outage.
 *
 *   · **23502** — an Apiroc connection stores ONLY the `end_user_account_id` pointer (Balo
 *     holds no provider tokens); migration 0069 dropped every Cronofy identity column
 *     outright, so a stray reference to one is now a compile error, not a runtime 23502.
 *
 *   · **A VOCABULARY THAT MIGRATED ONE WAY AND IS QUERIED THE OTHER** — migration 0068
 *     renames `status` → `credential_status` and replaces `connected|sync_pending|auth_error`
 *     with `ACTIVE|SYNC_PENDING|EXPIRED|REVOKED`. `.$type<CalendarCredentialStatus>()` turns
 *     the stale literal into a `tsc` error, but only real Postgres proves the CHECK, the
 *     DEFAULT and `findStaleConnections` actually agree with it.
 *
 * ⚠ Correction (BAL-467 fix brief round 2, item 14 — measured with
 * `DOCKER_HOST=tcp://127.0.0.1:1`): a comment here used to claim Docker-down makes
 * `pnpm test:integration` print "No test files found" and EXIT 0. The console banner does say
 * "exiting with code 0", but `global-setup.ts` throws FIRST and the process actually exits 1.
 * Docker-down turns CI red; it does not silently pass. Still check the test COUNT, not just
 * the exit code — a 0-exit with 0 tests run is the shape a regression in the HARNESS itself
 * would take.
 */

// ── Fixtures ──────────────────────────────────────────────────────

/** The Apiroc connect payload: a pointer and a status, no tokens (apiroc Constraint 1). */
function apirocInput(
  expertProfileId: string,
  provider: string,
  overrides: Partial<UpsertApirocConnectionInput> = {}
): UpsertApirocConnectionInput {
  return {
    expertProfileId,
    provider,
    endUserAccountId: `eua_${provider}`,
    providerEmail: `expert@${provider}.example`,
    ...overrides,
  };
}

/**
 * Force a distinct `created_at` on a connection.
 *
 * ⚠ MANDATORY BEFORE ANY ORDER-SENSITIVE ASSERTION, and the reason is a genuine trap:
 * `created_at` defaults to `now()`, which in Postgres is TRANSACTION START TIME, not wall
 * clock. The integration harness runs every test inside ONE transaction, so two rows
 * inserted seconds apart in a test share a BYTE-IDENTICAL `created_at`. The
 * `OLDEST_LIVE_FIRST` tie-break then falls through to `asc(id)` — a random v4 UUID — and
 * any "the oldest one wins" assertion becomes a coin flip that passes ~half the time.
 *
 * Production does not have this problem (each OAuth connect is its own transaction), so
 * stamping here does not weaken the test — it removes an artefact of the harness and
 * makes the ORDER BY the thing actually under test.
 */
async function stampCreatedAt(connectionId: string, iso: string): Promise<void> {
  await db
    .update(calendarConnections)
    .set({ createdAt: new Date(iso) })
    .where(eq(calendarConnections.id, connectionId));
}

/** Stamp the probe's scan key directly — `markCredentialChecked` is itself under test. */
async function stampCheckedAt(connectionId: string, checkedAt: Date | null): Promise<void> {
  await db
    .update(calendarConnections)
    .set({ credentialCheckedAt: checkedAt })
    .where(eq(calendarConnections.id, connectionId));
}

/**
 * The common two-provider fixture: a google connection genuinely OLDER than a microsoft
 * one, so `OLDEST_LIVE_FIRST` has a real ordering to resolve.
 */
async function seedGoogleThenMicrosoft(
  expertProfileId: string
): Promise<{ google: CalendarConnection; microsoft: CalendarConnection }> {
  const google = await calendarRepository.upsertApirocConnection(
    apirocInput(expertProfileId, 'google')
  );
  const microsoft = await calendarRepository.upsertApirocConnection(
    apirocInput(expertProfileId, 'microsoft')
  );
  await stampCreatedAt(google.id, '2026-01-01T00:00:00.000Z');
  await stampCreatedAt(microsoft.id, '2026-02-01T00:00:00.000Z');
  return { google, microsoft };
}

/** Every LIVE row for an expert — read straight from the table. */
async function liveRows(expertProfileId: string): Promise<CalendarConnection[]> {
  return db
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      )
    );
}

/** Every row for an expert, live or soft-deleted. */
async function allRows(expertProfileId: string): Promise<CalendarConnection[]> {
  return db
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.expertProfileId, expertProfileId));
}

/** One row by id, straight from the table (no repository read in the way). */
async function readRow(connectionId: string): Promise<CalendarConnection> {
  const [row] = await db
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.id, connectionId));
  if (row === undefined) throw new Error(`connection ${connectionId} not found`);
  return row;
}

// ── The cardinality ruling, positively ───────────────────────────

describe('calendar_connections — per (expert, provider) cardinality [ADR-1021 §1, 18 Aug 2026]', () => {
  it('lets ONE expert hold a live google AND a live microsoft connection at once', async () => {
    const expert = await expertDraftFactory();

    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );

    expect(google.id).not.toBe(microsoft.id);
    const live = await liveRows(expert.id);
    expect(live).toHaveLength(2);
    expect(live.map((row) => row.provider).sort()).toEqual(['google', 'microsoft']);
  });

  it('rejects a SECOND live row for the same (expert, provider) with 23505', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));

    // A raw insert, NOT an upsert: the upsert's whole job is to take the DO UPDATE arm.
    // This probes the index itself, which is what actually holds the ruling.
    await expectConstraintViolation('23505', (tx) =>
      tx
        .insert(calendarConnections)
        .values({ expertProfileId: expert.id, provider: 'google', endUserAccountId: 'eua_dupe' })
    );

    expect(await liveRows(expert.id)).toHaveLength(1);
  });
});

// ── The 42P10 arbiter gate + the Apiroc row shape ────────────────

describe('calendarRepository.upsertApirocConnection — the 42P10 arbiter gate', () => {
  /**
   * ⚠⚠ THE TEST THE CALENDAR CONNECT PATH HANGS ON. If the arbiter loses `provider` or its
   * `targetWhere`, Postgres cannot infer the arbiter and this raises 42P10 on the FIRST
   * statement below — not the second. Nothing else in CI catches it.
   */
  it('INSERTS on first call and UPDATES IN PLACE on the second — one row, same id, no 42P10', async () => {
    const expert = await expertDraftFactory();

    const first = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { endUserAccountId: 'eua_one' })
    );
    const second = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', {
        endUserAccountId: 'eua_two',
        credentialStatus: 'SYNC_PENDING',
      })
    );

    expect(second.id).toBe(first.id);
    expect(second.endUserAccountId).toBe('eua_two');
    expect(second.credentialStatus).toBe('SYNC_PENDING');
    expect(await liveRows(expert.id)).toHaveLength(1);
  });

  /**
   * ⚠ MIGRATION 0069 LANDED THIS PRECONDITION. It used to assert the four Cronofy identity
   * columns stayed NULL on every Apiroc row — the evidence that dropping them was safe. 0069
   * dropped them; the columns no longer exist to assert against. What survives is the positive
   * half: an Apiroc row writes ONLY its pointer plus Balo's own lifecycle columns.
   */
  it('writes a row with ONLY the pointer set, on the new vocabulary default', async () => {
    const expert = await expertDraftFactory();

    const row = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { endUserAccountId: 'eua_apiroc_1' })
    );

    expect(row.endUserAccountId).toBe('eua_apiroc_1');
    // The new vocabulary's default, proving migration 0068's `SET DEFAULT 'ACTIVE'` landed —
    // drizzle-kit emitted no default change for the renamed column, so this is the ONLY
    // gate on the hand-added statement. A surviving `'connected'` default would fail the
    // new CHECK on any insert that omits the column.
    expect(row.credentialStatus).toBe('ACTIVE');
    // A fresh connect has PROVEN nothing yet, so it is a probe candidate immediately.
    expect(row.credentialCheckedAt).toBeNull();
    expect(row.reconnectNotifiedAt).toBeNull();
  });

  it('upserting a SECOND provider takes the INSERT arm, leaving the first untouched', async () => {
    const expert = await expertDraftFactory();

    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { endUserAccountId: 'eua_google' })
    );
    await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft', { endUserAccountId: 'eua_microsoft' })
    );

    // A `provider`-less arbiter would have UPDATED the google row's pointer here, silently
    // destroying the google connection.
    const reread = await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google');
    expect(reread?.id).toBe(google.id);
    expect(reread?.endUserAccountId).toBe('eua_google');
    expect(await liveRows(expert.id)).toHaveLength(2);
  });

  it('reconnect AFTER disconnect INSERTS a fresh row beside the soft-deleted one — the partial-predicate proof', async () => {
    const expert = await expertDraftFactory();

    const first = await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    // A NON-partial unique index would still be INFERABLE as the arbiter here (predicate
    // implication is only required when the arbiter index IS partial), so the upsert would
    // take the DO UPDATE arm and RESURRECT the soft-deleted row via `deletedAt: null` — same
    // id, not a fresh one. Both assertions below catch that.
    const reconnected = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { endUserAccountId: 'eua_reconnected' })
    );

    expect(reconnected.id).not.toBe(first.id);
    expect(reconnected.deletedAt).toBeNull();
    expect(await liveRows(expert.id)).toHaveLength(1);
    // The soft-deleted row survives as history rather than being resurrected.
    expect(await allRows(expert.id)).toHaveLength(2);
  });

  /**
   * ⚠ THE ONE-LINE REGRESSION THAT WOULD SILENCE EVERY SECOND BREAKAGE. `reconnectNotifiedAt`
   * means "this expert has already been told about THIS breakage". A reconnect ends the
   * breakage, so the marker must go — otherwise the notify-once check suppresses the email
   * for the NEXT one, permanently.
   */
  it('re-upserting a LIVE row clears reconnectNotifiedAt and stamps credentialCheckedAt', async () => {
    const expert = await expertDraftFactory();
    const created = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.setCredentialStatus(created.id, 'EXPIRED');
    await calendarRepository.markReconnectNotified(
      created.id,
      new Date('2026-08-17T00:00:00.000Z')
    );
    expect((await readRow(created.id)).reconnectNotifiedAt).toBeInstanceOf(Date);

    const reconnected = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );

    expect(reconnected.id).toBe(created.id);
    expect(reconnected.credentialStatus).toBe('ACTIVE');
    expect(reconnected.reconnectNotifiedAt).toBeNull();
    expect(reconnected.credentialCheckedAt).toBeInstanceOf(Date);
  });
});

// ── The credential-status vocabulary, on real Postgres ───────────

describe('calendar_connections.credential_status — the CHECK is the backstop', () => {
  it('accepts every value in the new vocabulary', async () => {
    const expert = await expertDraftFactory();
    const row = await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));

    for (const status of ['ACTIVE', 'SYNC_PENDING', 'EXPIRED', 'REVOKED'] as const) {
      await calendarRepository.setCredentialStatus(row.id, status);
      expect((await readRow(row.id)).credentialStatus).toBe(status);
    }
  });

  /**
   * ⚠ THE MIGRATION-DIRECTION PROOF. `'connected'` is the Cronofy vocabulary migration 0068
   * translated away. `.$type<>()` makes it a compile error in Balo code, but nothing stops a
   * hand-written statement, a stale seed script or a rolled-back migration from writing it —
   * the CHECK is what makes that impossible rather than merely discouraged. Raw SQL, because
   * the typed column will not express the legacy value at all.
   */
  it('REJECTS the retired Cronofy vocabulary with 23514', async () => {
    const expert = await expertDraftFactory();

    // `end_user_account_id` is supplied so the statement fails on the CHECK under test
    // (23514), not on the unrelated NOT NULL migration 0069 added (23502).
    await expectConstraintViolation('23514', (tx) =>
      tx.execute(
        sql`INSERT INTO calendar_connections
              (expert_profile_id, provider, end_user_account_id, credential_status)
            VALUES (${expert.id}, 'google', 'eua_probe', 'connected')`
      )
    );
  });

  it('REJECTS a lower-cased new value — the vocabulary is case-exact', async () => {
    const expert = await expertDraftFactory();

    await expectConstraintViolation('23514', (tx) =>
      tx.execute(
        sql`INSERT INTO calendar_connections
              (expert_profile_id, provider, end_user_account_id, credential_status)
            VALUES (${expert.id}, 'google', 'eua_probe', 'active')`
      )
    );
  });
});

// ── Per-provider status writes (replacing the deleted fan-out) ───

describe('calendarRepository.setCredentialStatusForProvider', () => {
  /**
   * ⚠ REPLACES THE PINNED FAN-OUT. This suite used to assert that `updateConnectionStatus`
   * branded BOTH providers — "asserted as-is, not as-desired", with a note that BAL-396 would
   * have to CHOOSE to change it. This is that choice, asserted the other way: one provider's
   * breakage must never brand the other, because the booking gate fails CLOSED on a
   * non-ACTIVE connection and would make the expert unbookable on a healthy calendar.
   */
  it('moves ONE provider and leaves the other ACTIVE', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    await calendarRepository.setCredentialStatusForProvider(expert.id, 'google', 'EXPIRED');

    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google'))
        ?.credentialStatus
    ).toBe('EXPIRED');
    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'microsoft'))
        ?.credentialStatus
    ).toBe('ACTIVE');
  });

  it('clears the notification marker when the provider goes back to ACTIVE, and not otherwise', async () => {
    const expert = await expertDraftFactory();
    const row = await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.markReconnectNotified(row.id, new Date('2026-08-17T00:00:00.000Z'));

    await calendarRepository.setCredentialStatusForProvider(expert.id, 'google', 'REVOKED');
    expect((await readRow(row.id)).reconnectNotifiedAt).toBeInstanceOf(Date);

    await calendarRepository.setCredentialStatusForProvider(expert.id, 'google', 'ACTIVE');
    expect((await readRow(row.id)).reconnectNotifiedAt).toBeNull();
  });

  it('leaves a soft-deleted connection alone', async () => {
    const expert = await expertDraftFactory();
    const row = await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    await calendarRepository.setCredentialStatusForProvider(expert.id, 'google', 'EXPIRED');

    expect((await readRow(row.id)).credentialStatus).toBe('ACTIVE');
  });
});

describe('calendarRepository — connection-keyed credential writes', () => {
  it('setCredentialStatus writes one row and clears the marker only on the heal', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );
    await calendarRepository.markReconnectNotified(google.id, new Date('2026-08-17T00:00:00.000Z'));

    await calendarRepository.setCredentialStatus(google.id, 'EXPIRED');
    expect((await readRow(google.id)).credentialStatus).toBe('EXPIRED');
    expect((await readRow(google.id)).reconnectNotifiedAt).toBeInstanceOf(Date);
    expect((await readRow(microsoft.id)).credentialStatus).toBe('ACTIVE');

    await calendarRepository.setCredentialStatus(google.id, 'ACTIVE');
    expect((await readRow(google.id)).reconnectNotifiedAt).toBeNull();
  });

  /**
   * ⚠ BAL-414 — the EXECUTOR-AWARE ARM. The credential-break path now runs this flip inside
   * the same transaction as the `expert_profiles.searchable` de-list, so that a crash between
   * them cannot leave an EXPIRED credential on a still-searchable expert (bookable, with no
   * busy-time subtraction). Nested `db.transaction` is a SAVEPOINT under this harness, so the
   * rollback is contained and the outer per-test transaction survives.
   */
  it('setCredentialStatus rolls back with the caller transaction when an executor is passed', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );

    await expect(
      db.transaction(async (tx) => {
        await calendarRepository.setCredentialStatus(google.id, 'EXPIRED', tx);
        // Visible inside the transaction …
        const [inTx] = await tx
          .select({ credentialStatus: calendarConnections.credentialStatus })
          .from(calendarConnections)
          .where(eq(calendarConnections.id, google.id));
        expect(inTx?.credentialStatus).toBe('EXPIRED');
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    // … and gone after it rolls back.
    expect((await readRow(google.id)).credentialStatus).toBe('ACTIVE');
  });

  it('setCredentialStatus commits through a caller transaction with identical semantics', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );
    await calendarRepository.markReconnectNotified(google.id, new Date('2026-08-17T00:00:00.000Z'));

    await db.transaction(async (tx) => {
      await calendarRepository.setCredentialStatus(google.id, 'EXPIRED', tx);
    });

    expect((await readRow(google.id)).credentialStatus).toBe('EXPIRED');
    // ⚠ The notify-once marker SURVIVES a non-ACTIVE write on the executor arm too — that is
    // what makes "the expert has already been told about THIS breakage" meaningful.
    expect((await readRow(google.id)).reconnectNotifiedAt).toBeInstanceOf(Date);
    // One provider's breakage still never brands the other.
    expect((await readRow(microsoft.id)).credentialStatus).toBe('ACTIVE');

    await db.transaction(async (tx) => {
      await calendarRepository.setCredentialStatus(google.id, 'ACTIVE', tx);
    });

    // ⚠⚠ THE ONE-LINE REGRESSION THE EXECUTOR PARAMETER COULD HAVE INTRODUCED: writing
    // 'ACTIVE' must still clear the marker IN THE SAME STATEMENT, or a second breakage is
    // never announced.
    expect((await readRow(google.id)).credentialStatus).toBe('ACTIVE');
    expect((await readRow(google.id)).reconnectNotifiedAt).toBeNull();
  });

  it('setCredentialStatus leaves a soft-deleted connection alone on the executor arm', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    await db.transaction(async (tx) => {
      await calendarRepository.setCredentialStatus(google.id, 'EXPIRED', tx);
    });

    expect((await readRow(google.id)).credentialStatus).toBe('ACTIVE');
  });

  it('markCredentialChecked stamps the caller-supplied instant', async () => {
    const expert = await expertDraftFactory();
    const row = await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    const checkedAt = new Date('2026-08-18T09:30:00.000Z');

    await calendarRepository.markCredentialChecked(row.id, checkedAt);

    expect((await readRow(row.id)).credentialCheckedAt?.toISOString()).toBe(
      checkedAt.toISOString()
    );
  });

  it('markReconnectNotified stamps the marker for that connection only', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );
    const notifiedAt = new Date('2026-08-18T09:45:00.000Z');

    await calendarRepository.markReconnectNotified(google.id, notifiedAt);

    expect((await readRow(google.id)).reconnectNotifiedAt?.toISOString()).toBe(
      notifiedAt.toISOString()
    );
    expect((await readRow(microsoft.id)).reconnectNotifiedAt).toBeNull();
  });
});

// ── findStaleConnections — the Objection-1 regression test ───────

describe('calendarRepository.findStaleConnections', () => {
  /**
   * ⚠⚠ THE DIRECT REGRESSION TEST FOR THE SILENT-ZERO-ROWS MODE. The filter used to read
   * `eq(status, 'connected')`. Had the column been renamed without being TYPED, that literal
   * would still compile, match ZERO rows forever, and leave the 15-minute staleness cron
   * reporting nothing wrong while no connected expert's availability was ever resynced.
   * A vocabulary that migrated one way and is queried the other fails HERE, on real Postgres.
   */
  it('returns a freshly-seeded ACTIVE connection whose credential was last checked before the threshold', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await stampCheckedAt(google.id, new Date('2000-01-01T00:00:00.000Z'));

    const stale = await calendarRepository.findStaleConnections(
      new Date('2001-01-01T00:00:00.000Z')
    );

    expect(stale.map((row) => row.id)).toContain(google.id);
  });

  /**
   * ⚠⚠ THE BAL-396 FIX-ROUND MANDATORY TEST. `findStaleConnections` used to filter on
   * `last_synced_at`, whose only production writer was the Cronofy-era webhook route this
   * PR deletes — so every row's `last_synced_at` is NULL forever, `lt(NULL, threshold)` is
   * NULL (not true), and the query returned `[]` on EVERY tick: a PERMANENT no-op, not a
   * genuinely-empty result. Repointing at `credential_checked_at` — which a fresh connect
   * leaves NULL until the first probe or reconnect — restores a real signal: a never-synced
   * connection is exactly the one most in need of an availability rebuild, so it must be a
   * candidate from the moment it connects, not excluded the way NULL `last_synced_at` used
   * to exclude it.
   */
  it('returns a NEVER-CHECKED connection — a never-synced connection must not be a permanent no-op', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    // A fresh connect already leaves credential_checked_at NULL (see the `upsertApirocConnection`
    // "writes a row with ONLY the pointer set" test above) — no extra stamp needed.

    const stale = await calendarRepository.findStaleConnections(
      new Date('2001-01-01T00:00:00.000Z')
    );

    expect(stale.map((row) => row.id)).toContain(google.id);
  });

  it('EXCLUDES a connection whose credential was proven inside the threshold window', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await stampCheckedAt(google.id, new Date('2026-08-18T11:50:00.000Z'));

    const stale = await calendarRepository.findStaleConnections(
      new Date('2026-08-18T11:45:00.000Z')
    );

    expect(stale.map((row) => row.id)).not.toContain(google.id);
  });

  it('returns ONE ROW PER PROVIDER — what the availability job wants', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );
    await stampCheckedAt(google.id, new Date('2000-01-01T00:00:00.000Z'));
    await stampCheckedAt(microsoft.id, new Date('2000-01-01T00:00:00.000Z'));

    const stale = await calendarRepository.findStaleConnections(
      new Date('2001-01-01T00:00:00.000Z')
    );
    const ours = stale.filter((row) => row.expertProfileId === expert.id);
    expect(ours.map((row) => row.id).sort()).toEqual([google.id, microsoft.id].sort());
  });

  it('EXCLUDES a broken connection — a dead credential is not a resync candidate', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await stampCheckedAt(google.id, new Date('2000-01-01T00:00:00.000Z'));
    await calendarRepository.setCredentialStatus(google.id, 'EXPIRED');

    const stale = await calendarRepository.findStaleConnections(
      new Date('2001-01-01T00:00:00.000Z')
    );

    expect(stale.map((row) => row.id)).not.toContain(google.id);
  });
});

// ── listConnectionsDueForHealthCheck — the probe's candidate scan ─

describe('calendarRepository.listConnectionsDueForHealthCheck', () => {
  it('puts NEVER-CHECKED connections first, then the oldest check', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );
    await stampCheckedAt(microsoft.id, new Date('2026-08-18T08:00:00.000Z'));
    await stampCheckedAt(google.id, null);

    const due = await calendarRepository.listConnectionsDueForHealthCheck(
      new Date('2026-08-18T09:00:00.000Z'),
      50
    );
    const ours = due.filter((row) => row.expertProfileId === expert.id);

    // NULL means "never proven", which is the most urgent candidate — an ASC sort that
    // defaulted to NULLS LAST would starve exactly those connections.
    expect(ours.map((row) => row.id)).toEqual([google.id, microsoft.id]);
  });

  it('EXCLUDES a connection already proven inside the interval', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await stampCheckedAt(google.id, new Date('2026-08-18T08:59:00.000Z'));

    const due = await calendarRepository.listConnectionsDueForHealthCheck(
      new Date('2026-08-18T08:00:00.000Z'),
      50
    );

    expect(due.map((row) => row.id)).not.toContain(google.id);
  });

  it('returns NON-ACTIVE connections too — the probe is also the healer', async () => {
    const expert = await expertDraftFactory();
    const pending = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { credentialStatus: 'SYNC_PENDING' })
    );
    const expired = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft', { credentialStatus: 'EXPIRED' })
    );

    const due = await calendarRepository.listConnectionsDueForHealthCheck(
      new Date('2026-08-18T09:00:00.000Z'),
      50
    );
    const ourIds = due.filter((row) => row.expertProfileId === expert.id).map((row) => row.id);

    // Filtering to ACTIVE here would make every broken connection permanently broken.
    expect(ourIds).toContain(pending.id);
    expect(ourIds).toContain(expired.id);
  });

  it('EXCLUDES a soft-deleted connection', async () => {
    const expert = await expertDraftFactory();
    const disconnected = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'microsoft');

    const due = await calendarRepository.listConnectionsDueForHealthCheck(
      new Date('2026-08-18T09:00:00.000Z'),
      50
    );

    // A disconnected connection must not be probed — a vendor call spent to learn nothing,
    // and an email about a calendar the expert unhooked themselves.
    expect(due.map((row) => row.id)).not.toContain(disconnected.id);
  });

  it('honours the batch bound', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    const due = await calendarRepository.listConnectionsDueForHealthCheck(
      new Date('2026-08-18T09:00:00.000Z'),
      1
    );

    expect(due).toHaveLength(1);
  });
});

// ── listBusyReadTargets — what the free/busy read may act on ─────

describe('calendarRepository.listBusyReadTargets', () => {
  it('returns only conflict-checked calendar ids, with the pointer the vendor call needs', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { endUserAccountId: 'eua_busy' })
    );
    await calendarRepository.replaceSubCalendars(google.id, [
      {
        calendarId: 'cal_work',
        name: 'Work',
        provider: 'google',
        isPrimary: true,
        conflictCheck: true,
      },
      {
        calendarId: 'cal_personal',
        name: 'Personal',
        provider: 'google',
        isPrimary: false,
        conflictCheck: false,
      },
    ]);

    const targets = await calendarRepository.listBusyReadTargets(expert.id);

    expect(targets).toEqual([
      {
        connectionId: google.id,
        provider: 'google',
        endUserAccountId: 'eua_busy',
        credentialStatus: 'ACTIVE',
        calendarIds: ['cal_work'],
        provisioned: true,
      },
    ]);
  });

  /**
   * ⚠ TWO DIFFERENT EMPTY ANSWERS. `calendarIds: []` with `provisioned: true` is the expert's
   * explicit choice to conflict-check nothing — not a failure. `provisioned: false` means
   * Balo never listed this account's calendars, so the read CANNOT be performed
   * (`GetFreeBusyInput.calendarIds` is required by the vendor) and the booking gate must fail
   * closed. Conflating them fails the gate OPEN and double-books the expert.
   */
  it('reports provisioned: false for a connection with NO sub-calendar rows', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { credentialStatus: 'SYNC_PENDING' })
    );

    const [target] = await calendarRepository.listBusyReadTargets(expert.id);

    expect(target).toMatchObject({
      credentialStatus: 'SYNC_PENDING',
      calendarIds: [],
      provisioned: false,
    });
  });

  it('reports provisioned: true with an EMPTY id list when the expert conflict-checks nothing', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.replaceSubCalendars(google.id, [
      {
        calendarId: 'cal_personal',
        name: 'Personal',
        provider: 'google',
        isPrimary: true,
        conflictCheck: false,
      },
    ]);

    const [target] = await calendarRepository.listBusyReadTargets(expert.id);

    expect(target).toMatchObject({ calendarIds: [], provisioned: true });
  });

  it('returns a BROKEN connection too, so the caller can fail closed rather than open', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.replaceSubCalendars(google.id, [
      {
        calendarId: 'cal_work',
        name: 'Work',
        provider: 'google',
        isPrimary: true,
        conflictCheck: true,
      },
    ]);
    await calendarRepository.setCredentialStatus(google.id, 'EXPIRED');

    const [target] = await calendarRepository.listBusyReadTargets(expert.id);

    // Dropping it here would look like "this expert has no external calendar" — the exact
    // shape of a double-booking in front of a paying client.
    expect(target).toMatchObject({ credentialStatus: 'EXPIRED', calendarIds: ['cal_work'] });
  });

  it('unions across providers, oldest connection first', async () => {
    const expert = await expertDraftFactory();
    const { google, microsoft } = await seedGoogleThenMicrosoft(expert.id);
    await calendarRepository.replaceSubCalendars(google.id, [
      {
        calendarId: 'cal_g',
        name: 'G',
        provider: 'google',
        isPrimary: true,
        conflictCheck: true,
      },
    ]);
    await calendarRepository.replaceSubCalendars(microsoft.id, [
      {
        calendarId: 'cal_m',
        name: 'M',
        provider: 'microsoft',
        isPrimary: true,
        conflictCheck: true,
      },
    ]);

    const targets = await calendarRepository.listBusyReadTargets(expert.id);

    expect(targets.map((target) => target.calendarIds)).toEqual([['cal_g'], ['cal_m']]);
  });

  it('EXCLUDES a soft-deleted connection', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    expect(
      (await calendarRepository.listBusyReadTargets(expert.id)).map((t) => t.provider).sort()
    ).toEqual(['google', 'microsoft']);

    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'microsoft');
    expect(
      (await calendarRepository.listBusyReadTargets(expert.id)).map((t) => t.provider)
    ).toEqual(['google']);
  });

  it('returns [] for an expert with no connection at all', async () => {
    const expert = await expertDraftFactory();
    expect(await calendarRepository.listBusyReadTargets(expert.id)).toEqual([]);
  });
});

// ── Reads: provider-scoped, fan-out, and legacy-singular ─────────

describe('calendarRepository — findConnectionById (BAL-468)', () => {
  it('returns the one live connection for a bare row id', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    const found = await calendarRepository.findConnectionById(google.id);
    expect(found?.id).toBe(google.id);
    expect(found?.provider).toBe('google');
    expect(found?.expertProfileId).toBe(expert.id);
  });

  it('excludes a soft-deleted connection — a disconnected row must look absent', async () => {
    // ⚠ THE POINT OF THIS TEST. A `calendar_subscriptions` row outlives a disconnect, so the
    // reconcile worker and the webhook both reach here holding a `connection_id` whose
    // connection the expert has since unhooked. Answering the row would resurrect a calendar
    // they deliberately removed; answering `undefined` makes both callers reconcile to "gone".
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    expect(await calendarRepository.findConnectionById(google.id)).toBeUndefined();
  });

  it('returns undefined for an id that names no connection', async () => {
    expect(
      await calendarRepository.findConnectionById('00000000-0000-0000-0000-000000000000')
    ).toBeUndefined();
  });
});

describe('calendarRepository — provider-scoped reads', () => {
  it('findConnectionByExpertAndProvider returns the matching provider and nothing else', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );

    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google'))?.id
    ).toBe(google.id);
    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'microsoft'))?.id
    ).toBe(microsoft.id);
    expect(
      await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'apple')
    ).toBeUndefined();
  });

  it('findConnectionByExpertAndProvider excludes a soft-deleted connection', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    expect(
      await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google')
    ).toBeUndefined();
  });

  it('listConnectionsByExpertProfileId returns BOTH providers, oldest first, and excludes soft-deleted rows', async () => {
    const expert = await expertDraftFactory();
    await seedGoogleThenMicrosoft(expert.id);

    // The amendment's availability rule reads onto exactly this: "the union of busy
    // blocks across ALL of the expert's connections".
    expect(
      (await calendarRepository.listConnectionsByExpertProfileId(expert.id)).map(
        (row) => row.provider
      )
    ).toEqual(['google', 'microsoft']);

    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');
    expect(
      (await calendarRepository.listConnectionsByExpertProfileId(expert.id)).map(
        (row) => row.provider
      )
    ).toEqual(['microsoft']);
  });

  it('listConnectionsByExpertProfileId returns [] for an expert with no connection', async () => {
    const expert = await expertDraftFactory();
    expect(await calendarRepository.listConnectionsByExpertProfileId(expert.id)).toEqual([]);
  });

  it('findConnectionsByEndUserAccountId resolves the pointer, and returns EVERY match', async () => {
    const alex = await expertDraftFactory();
    const dana = await expertDraftFactory();

    await calendarRepository.upsertApirocConnection(
      apirocInput(alex.id, 'google', { endUserAccountId: 'eua_shared' })
    );
    await calendarRepository.upsertApirocConnection(
      apirocInput(dana.id, 'google', { endUserAccountId: 'eua_shared' })
    );
    await calendarRepository.upsertApirocConnection(
      apirocInput(alex.id, 'microsoft', { endUserAccountId: 'eua_other' })
    );

    // ⚠ TWO EXPERTS ON ONE END USER ACCOUNT IS LEGAL, and BAL-396 RULED IT STAYS THAT WAY:
    // the vendor keys End User Accounts by provider account, not by Balo's `externalId`, so
    // two experts connecting the same Google account very likely receive the SAME id. A
    // unique index would surface that as a bare 23505 at connect time.
    const shared = await calendarRepository.findConnectionsByEndUserAccountId('eua_shared');
    expect(shared).toHaveLength(2);
    expect(shared.map((row) => row.expertProfileId).sort()).toEqual([alex.id, dana.id].sort());

    expect(await calendarRepository.findConnectionsByEndUserAccountId('eua_other')).toHaveLength(1);
    expect(await calendarRepository.findConnectionsByEndUserAccountId('eua_absent')).toEqual([]);
  });

  it('findConnectionsByEndUserAccountId excludes soft-deleted rows', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google', { endUserAccountId: 'eua_gone' })
    );
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    expect(await calendarRepository.findConnectionsByEndUserAccountId('eua_gone')).toEqual([]);
  });
});

describe('calendarRepository — LEGACY-SINGLE-CONNECTION reads answer deterministically', () => {
  it('findConnectionByExpertProfileId returns the OLDEST live connection, not an arbitrary one', async () => {
    const expert = await expertDraftFactory();
    const { google } = await seedGoogleThenMicrosoft(expert.id);

    // Both rows are equally valid answers to a query that cannot name a provider. Pinning
    // "oldest" means a caller's behaviour cannot flip between runs with no code change.
    expect((await calendarRepository.findConnectionByExpertProfileId(expert.id))?.id).toBe(
      google.id
    );
  });

  it('findConnectionByExpertProfileId still returns the oldest when microsoft was connected FIRST', async () => {
    const expert = await expertDraftFactory();
    const { google, microsoft } = await seedGoogleThenMicrosoft(expert.id);
    await stampCreatedAt(microsoft.id, '2025-01-01T00:00:00.000Z');

    const found = await calendarRepository.findConnectionByExpertProfileId(expert.id);
    expect(found?.id).toBe(microsoft.id);
    expect(found?.id).not.toBe(google.id);
  });

  it('findConnectionByExpertProfileId skips to the surviving provider once the oldest is disconnected', async () => {
    const expert = await expertDraftFactory();
    const { microsoft } = await seedGoogleThenMicrosoft(expert.id);
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    expect((await calendarRepository.findConnectionByExpertProfileId(expert.id))?.id).toBe(
      microsoft.id
    );
  });
});

// ── Writes: provider-scoped siblings vs the documented fan-out ───

describe('calendarRepository — per-provider writes', () => {
  it('updateTargetCalendarIdForProvider writes ONE connection, leaving the other alone', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    await calendarRepository.updateTargetCalendarIdForProvider(expert.id, 'google', 'cal_google');

    // "targetCalendarId is per connection" — a calendar id is only meaningful inside the
    // provider account that issued it. The expert-wide fan-out that used to write BOTH rows
    // is deleted (BAL-396).
    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google'))
        ?.targetCalendarId
    ).toBe('cal_google');
    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'microsoft'))
        ?.targetCalendarId
    ).toBeNull();
  });

  it('softDeleteConnectionForProvider disconnects ONE provider and leaves the other live', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    const microsoft = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'microsoft')
    );

    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    const live = await liveRows(expert.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(microsoft.id);
    expect(await allRows(expert.id)).toHaveLength(2);
  });

  it('softDeleteConnection disconnects EVERY provider — the whole-account disconnect', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'google'));
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    // Deliberately a fan-out: this is "disconnect my calendar" in the whole-account sense,
    // and the path `expert_profiles` teardown depends on.
    await calendarRepository.softDeleteConnection(expert.id);

    expect(await liveRows(expert.id)).toHaveLength(0);
    expect(await allRows(expert.id)).toHaveLength(2);
  });

  it('updateLastSyncedAt is keyed by connectionId, so it touches only that provider', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertApirocConnection(
      apirocInput(expert.id, 'google')
    );
    await calendarRepository.upsertApirocConnection(apirocInput(expert.id, 'microsoft'));

    await calendarRepository.updateLastSyncedAt(google.id);

    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google'))
        ?.lastSyncedAt
    ).toBeInstanceOf(Date);
    expect(
      (await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'microsoft'))
        ?.lastSyncedAt
    ).toBeNull();
  });
});
