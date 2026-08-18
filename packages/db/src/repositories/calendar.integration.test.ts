import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { calendarConnections, type CalendarConnection } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { calendarRepository } from './calendar';

/**
 * BAL-467 — `calendar_connections` against REAL Postgres.
 *
 * ADR-1021, amendment 18 Aug 2026 §1: "A calendar connection is per (expert, provider) …
 * unique on `(expertId, provider)`. An expert may hold connections to multiple providers
 * at once … connect, disconnect, and reconnect are per-provider."
 *
 * ⚠⚠ THIS SUITE IS NOT A COVERAGE CHECKBOX. It is the ONLY gate in the repository that
 * can catch the two failure modes BAL-467 introduces, both of which leave typecheck,
 * lint AND the existing unit test green:
 *
 *   · **42P10** — migration 0067 DROPS `cal_conn_expert_profile_idx`, which was
 *     `upsertConnection`'s ON CONFLICT arbiter. An arbiter that still names
 *     `expertProfileId` alone, or that omits `targetWhere` for the new PARTIAL index,
 *     fails arbiter inference AT PLAN TIME — so the FIRST upsert on an EMPTY table
 *     raises "no unique or exclusion constraint matching the ON CONFLICT specification".
 *     `calendar.test.ts` cannot see this: it mocks the whole Drizzle client, so
 *     `onConflictDoUpdate` merely records its argument and never reaches a planner.
 *     This is the live Cronofy connect path — a break here is a production outage.
 *
 *   · **23502** — an Apiroc connection stores ONLY the `end_user_account_id` pointer
 *     (Balo holds no provider tokens). If any of the four Cronofy `NOT NULL`s survives
 *     the migration, that insert fails and the table is unwritable for the vendor this
 *     ticket exists to onboard.
 *
 * ⚠ Correction (fix brief round 2, item 14 — measured with `DOCKER_HOST=tcp://127.0.0.1:1`):
 * this comment used to claim Docker-down makes `pnpm test:integration` print "No test files
 * found" and EXIT 0. That's not what happens — the console banner DOES say "exiting with
 * code 0", but `global-setup.ts` throws FIRST (before Testcontainers can start), and the
 * process actually exits 1. Docker-down turns CI red, it does not silently pass. Still check
 * the test COUNT, not just the exit code, when running this locally — a 0-exit with 0 tests
 * run is the shape a REGRESSION in the harness itself (not Docker being down) would take.
 */

// ── Fixtures ──────────────────────────────────────────────────────

/**
 * A Cronofy-shaped upsert payload. `upsertConnection`'s input still requires
 * `cronofySub` + the three token fields — that shape is Cronofy-only and dies with
 * BAL-396; BAL-467 changes only its ARBITER.
 */
function cronofyInput(
  expertProfileId: string,
  provider: string,
  overrides: { cronofySub?: string; accessToken?: string; status?: string } = {}
): Parameters<typeof calendarRepository.upsertConnection>[0] {
  return {
    expertProfileId,
    provider,
    cronofySub: overrides.cronofySub ?? `sub_${provider}`,
    providerEmail: `expert@${provider}.example`,
    accessToken: overrides.accessToken ?? `enc_access_${provider}`,
    refreshToken: `enc_refresh_${provider}`,
    tokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  };
}

/**
 * Insert an APIROC-SHAPED row directly. Deliberately NOT via `upsertConnection`: no
 * Apiroc writer exists yet (BAL-396 owns it), and routing through the Cronofy-shaped
 * input would populate the very columns this asserts can be NULL.
 */
async function insertApirocConnection(
  expertProfileId: string,
  provider: string,
  endUserAccountId: string
): Promise<CalendarConnection> {
  const [row] = await db
    .insert(calendarConnections)
    .values({ expertProfileId, provider, endUserAccountId })
    .returning();
  if (row === undefined) throw new Error('apiroc insert returned no row');
  return row;
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

/**
 * The common two-provider fixture: a google connection genuinely OLDER than a microsoft
 * one, so `OLDEST_LIVE_FIRST` has a real ordering to resolve.
 */
async function seedGoogleThenMicrosoft(
  expertProfileId: string
): Promise<{ google: CalendarConnection; microsoft: CalendarConnection }> {
  const google = await calendarRepository.upsertConnection(cronofyInput(expertProfileId, 'google'));
  const microsoft = await calendarRepository.upsertConnection(
    cronofyInput(expertProfileId, 'microsoft')
  );
  await stampCreatedAt(google.id, '2026-01-01T00:00:00.000Z');
  await stampCreatedAt(microsoft.id, '2026-02-01T00:00:00.000Z');
  return { google, microsoft };
}

/** Every LIVE row for an expert, oldest first — read straight from the table. */
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

// ── The cardinality ruling, positively ───────────────────────────

describe('calendar_connections — per (expert, provider) cardinality [ADR-1021 §1, 18 Aug 2026]', () => {
  it('lets ONE expert hold a live google AND a live microsoft connection at once', async () => {
    const expert = await expertDraftFactory();

    const google = await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    const microsoft = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'microsoft')
    );

    expect(google.id).not.toBe(microsoft.id);
    const live = await liveRows(expert.id);
    expect(live).toHaveLength(2);
    expect(live.map((row) => row.provider).sort()).toEqual(['google', 'microsoft']);
  });

  it('rejects a SECOND live row for the same (expert, provider) with 23505', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));

    // A raw insert, NOT an upsert: the upsert's whole job is to take the DO UPDATE arm.
    // This probes the index itself, which is what actually holds the ruling.
    await expectConstraintViolation('23505', (tx) =>
      tx
        .insert(calendarConnections)
        .values({ expertProfileId: expert.id, provider: 'google', cronofySub: 'sub_dupe' })
    );

    expect(await liveRows(expert.id)).toHaveLength(1);
  });
});

// ── The 42P10 regression gate ────────────────────────────────────

describe('calendarRepository.upsertConnection — the 42P10 arbiter gate', () => {
  /**
   * ⚠⚠ THE TEST THE LIVE CRONOFY CONNECT PATH HANGS ON. If the arbiter loses `provider`
   * or its `targetWhere`, Postgres cannot infer the arbiter and this raises 42P10 on the
   * FIRST statement below — not the second. Nothing else in CI catches it.
   */
  it('INSERTS on first call and UPDATES IN PLACE on the second — one row, same id, no 42P10', async () => {
    const expert = await expertDraftFactory();

    const first = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'google', { cronofySub: 'sub_one', accessToken: 'enc_one' })
    );

    const second = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'google', {
        cronofySub: 'sub_two',
        accessToken: 'enc_two',
        status: 'sync_pending',
      })
    );

    expect(second.id).toBe(first.id);
    expect(second.cronofySub).toBe('sub_two');
    expect(second.accessToken).toBe('enc_two');
    expect(second.status).toBe('sync_pending');
    expect(await liveRows(expert.id)).toHaveLength(1);
  });

  it('upserting a SECOND provider takes the INSERT arm, leaving the first untouched', async () => {
    const expert = await expertDraftFactory();

    const google = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'google', { accessToken: 'enc_google' })
    );
    await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'microsoft', { accessToken: 'enc_microsoft' })
    );

    // The pre-BAL-467 arbiter would have UPDATED the google row's provider to
    // 'microsoft' here, silently destroying the google connection.
    const reread = await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google');
    expect(reread?.id).toBe(google.id);
    expect(reread?.accessToken).toBe('enc_google');
    expect(await liveRows(expert.id)).toHaveLength(2);
  });

  it('reconnect AFTER disconnect INSERTS a fresh row beside the soft-deleted one — the partial-predicate proof', async () => {
    const expert = await expertDraftFactory();

    const first = await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    // Correction (fix brief round 2, item 14): this used to claim a NON-partial unique
    // index "fails HERE with 23505". Measured — it would not: Postgres only requires
    // predicate implication when the arbiter index IS partial (`predicate_implied_by`
    // against an empty predicate is trivially true), so a non-partial unique index is
    // still INFERABLE as the ON CONFLICT arbiter here. The upsert would instead take the
    // DO UPDATE arm and RESURRECT the soft-deleted row via `deletedAt: null`
    // (`repositories/calendar.ts`'s `set` clause) — same row id, not a fresh one. The two
    // assertions below still catch that regression (id unchanged; only 1 row total instead
    // of 2), just for a different reason than originally documented — this is the
    // documented Balo soft-delete/unique footgun, but the failure mode is silent
    // resurrection, not 23505.
    const reconnected = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'google', { cronofySub: 'sub_reconnected' })
    );

    expect(reconnected.id).not.toBe(first.id);
    expect(reconnected.deletedAt).toBeNull();
    expect(await liveRows(expert.id)).toHaveLength(1);
    // The soft-deleted row survives as history rather than being resurrected.
    expect(await allRows(expert.id)).toHaveLength(2);
  });
});

// ── The Apiroc row shape (§1b — the four DROP NOT NULLs) ─────────

describe('calendar_connections — an Apiroc-shaped row is writable', () => {
  it('accepts a row with only end_user_account_id set and all four Cronofy columns NULL', async () => {
    const expert = await expertDraftFactory();

    // Fails 23502 if ANY of cronofy_sub / access_token / refresh_token /
    // token_expires_at kept its NOT NULL through migration 0067.
    const row = await insertApirocConnection(expert.id, 'google', 'eua_apiroc_1');

    expect(row.endUserAccountId).toBe('eua_apiroc_1');
    expect(row.cronofySub).toBeNull();
    expect(row.accessToken).toBeNull();
    expect(row.refreshToken).toBeNull();
    expect(row.tokenExpiresAt).toBeNull();
    // `status` defaults, so an Apiroc insert that omits it still satisfies
    // cal_conn_status_check — which is why BAL-467 leaves that column alone.
    expect(row.status).toBe('connected');
  });

  it('an Apiroc row and a Cronofy row coexist for one expert on different providers', async () => {
    const expert = await expertDraftFactory();

    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await insertApirocConnection(expert.id, 'microsoft', 'eua_apiroc_2');

    const live = await calendarRepository.listConnectionsByExpertProfileId(expert.id);
    expect(live).toHaveLength(2);
    // The table is genuinely dual-tenanted for one release: each row carries exactly
    // one vendor's identity and NULLs the other's.
    const google = live.find((row) => row.provider === 'google');
    const microsoft = live.find((row) => row.provider === 'microsoft');
    expect(google?.cronofySub).toBe('sub_google');
    expect(google?.endUserAccountId).toBeNull();
    expect(microsoft?.endUserAccountId).toBe('eua_apiroc_2');
    expect(microsoft?.cronofySub).toBeNull();
  });
});

// ── Reads: provider-scoped, fan-out, and legacy-singular ─────────

describe('calendarRepository — provider-scoped reads', () => {
  it('findConnectionByExpertAndProvider returns the matching provider and nothing else', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    const microsoft = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'microsoft')
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
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
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

    await insertApirocConnection(alex.id, 'google', 'eua_shared');
    await insertApirocConnection(dana.id, 'google', 'eua_shared');
    await insertApirocConnection(alex.id, 'microsoft', 'eua_other');

    // ⚠ TWO EXPERTS ON ONE END USER ACCOUNT IS LEGAL, and this is why the method returns
    // an array: `cal_conn_end_user_account_idx` is deliberately NON-unique, because no
    // ruling establishes one-account-per-expert. A singular signature would hand
    // BAL-468's webhook handler an arbitrary one of these two rows.
    const shared = await calendarRepository.findConnectionsByEndUserAccountId('eua_shared');
    expect(shared).toHaveLength(2);
    expect(shared.map((row) => row.expertProfileId).sort()).toEqual([alex.id, dana.id].sort());

    expect(await calendarRepository.findConnectionsByEndUserAccountId('eua_other')).toHaveLength(1);
    expect(await calendarRepository.findConnectionsByEndUserAccountId('eua_absent')).toEqual([]);
  });

  it('findConnectionsByEndUserAccountId excludes soft-deleted rows', async () => {
    const expert = await expertDraftFactory();
    await insertApirocConnection(expert.id, 'google', 'eua_gone');
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
    // Reversed ages, same insertion order — the answer must follow created_at, not
    // insertion order and not the UUID tie-break.
    const { google, microsoft } = await seedGoogleThenMicrosoft(expert.id);
    await stampCreatedAt(microsoft.id, '2025-01-01T00:00:00.000Z');

    const found = await calendarRepository.findConnectionByExpertProfileId(expert.id);
    expect(found?.id).toBe(microsoft.id);
    expect(found?.id).not.toBe(google.id);
  });

  it('findConnectionByExpertProfileId skips to the surviving provider once the oldest is disconnected', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    const microsoft = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'microsoft')
    );
    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    expect((await calendarRepository.findConnectionByExpertProfileId(expert.id))?.id).toBe(
      microsoft.id
    );
  });

  it('findConnectionWithSubCalendars returns the OLDEST live connection with its sub-calendars', async () => {
    const expert = await expertDraftFactory();
    const { google } = await seedGoogleThenMicrosoft(expert.id);
    await calendarRepository.replaceSubCalendars(google.id, [
      {
        calendarId: 'cal_primary',
        name: 'Primary',
        provider: 'google',
        isPrimary: true,
        conflictCheck: true,
      },
    ]);

    const found = await calendarRepository.findConnectionWithSubCalendars(expert.id);
    expect(found?.id).toBe(google.id);
    expect(found?.subCalendars.map((sub) => sub.calendarId)).toEqual(['cal_primary']);
  });
});

// ── Writes: provider-scoped siblings vs the documented fan-outs ──

describe('calendarRepository — per-provider writes', () => {
  it('updateTargetCalendarIdForProvider writes ONE connection, leaving the other alone', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'microsoft'));

    await calendarRepository.updateTargetCalendarIdForProvider(expert.id, 'google', 'cal_google');

    // "targetCalendarId is per connection" — a calendar id is only meaningful inside the
    // provider account that issued it.
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
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    const microsoft = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'microsoft')
    );

    await calendarRepository.softDeleteConnectionForProvider(expert.id, 'google');

    const live = await liveRows(expert.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(microsoft.id);
    expect(await allRows(expert.id)).toHaveLength(2);
  });
});

describe('calendarRepository — the DOCUMENTED fan-outs (pinned so BAL-396 knows what it changes)', () => {
  it('softDeleteConnection disconnects EVERY provider — whole-account disconnect', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'microsoft'));

    await calendarRepository.softDeleteConnection(expert.id);

    expect(await liveRows(expert.id)).toHaveLength(0);
    expect(await allRows(expert.id)).toHaveLength(2);
  });

  it('updateConnectionStatus brands BOTH providers — the known imprecision BAL-396 §2 fixes', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'microsoft'));

    await calendarRepository.updateConnectionStatus(expert.id, 'auth_error');

    // ⚠ ASSERTED AS-IS, NOT AS-DESIRED. One provider's auth failure should not brand the
    // other's connection; making it per-provider needs the credential-status lifecycle
    // that gives the value meaning, which is BAL-396 §2/§9. Pinning today's behaviour
    // means that ticket has to CHOOSE to change it rather than discover it.
    const live = await calendarRepository.listConnectionsByExpertProfileId(expert.id);
    expect(live.map((row) => row.status)).toEqual(['auth_error', 'auth_error']);
  });

  it('updateTargetCalendarId (legacy) writes BOTH providers — superseded by the per-provider sibling', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'microsoft'));

    await calendarRepository.updateTargetCalendarId(expert.id, 'cal_everything');

    const live = await calendarRepository.listConnectionsByExpertProfileId(expert.id);
    expect(live.map((row) => row.targetCalendarId)).toEqual(['cal_everything', 'cal_everything']);
  });
});

// ── Methods unaffected by BAL-467, pinned as such ────────────────

describe('calendarRepository — connection reads unaffected by the cardinality change', () => {
  it('findConnectionByChannelId still names exactly one row across two providers', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'microsoft'));

    await calendarRepository.updateConnectionChannelId(expert.id, 'chn_shared');
    // The channel write is itself a fan-out (Cronofy-only, dies with BAL-396), so scope
    // the read by re-keying one row to a distinct channel.
    await db
      .update(calendarConnections)
      .set({ channelId: 'chn_google' })
      .where(eq(calendarConnections.id, google.id));

    expect((await calendarRepository.findConnectionByChannelId('chn_google'))?.id).toBe(google.id);
    expect(await calendarRepository.findConnectionByChannelId('chn_absent')).toBeUndefined();
  });

  it('findStaleConnections now returns ONE ROW PER PROVIDER — what the availability job wants', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    const microsoft = await calendarRepository.upsertConnection(
      cronofyInput(expert.id, 'microsoft')
    );

    const longAgo = new Date('2000-01-01T00:00:00.000Z');
    await db
      .update(calendarConnections)
      .set({ lastSyncedAt: longAgo })
      .where(eq(calendarConnections.expertProfileId, expert.id));

    const stale = await calendarRepository.findStaleConnections(
      new Date('2001-01-01T00:00:00.000Z')
    );
    const ours = stale.filter((row) => row.expertProfileId === expert.id);
    expect(ours.map((row) => row.id).sort()).toEqual([google.id, microsoft.id].sort());
  });

  it('updateLastSyncedAt is keyed by connectionId, so it touches only that provider', async () => {
    const expert = await expertDraftFactory();
    const google = await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'microsoft'));

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

  it('updateConnectionTokens rewrites the Cronofy credential columns for ONE (expert, provider) connection', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));

    const expiresAt = new Date('2098-06-01T00:00:00.000Z');
    await calendarRepository.updateConnectionTokens(expert.id, 'google', {
      accessToken: 'enc_rotated',
      refreshToken: 'enc_rotated_refresh',
      tokenExpiresAt: expiresAt,
    });

    const row = await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google');
    expect(row?.accessToken).toBe('enc_rotated');
    expect(row?.refreshToken).toBe('enc_rotated_refresh');
    expect(row?.tokenExpiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it('updateConnectionTokens leaves the refresh token alone when it is omitted', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));

    await calendarRepository.updateConnectionTokens(expert.id, 'google', {
      accessToken: 'enc_rotated_only',
      tokenExpiresAt: new Date('2098-06-01T00:00:00.000Z'),
    });

    const row = await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google');
    expect(row?.accessToken).toBe('enc_rotated_only');
    expect(row?.refreshToken).toBe('enc_refresh_google');
  });

  /**
   * A2 (security review CRITICAL) — the regression this fix exists for. Before the fix,
   * `updateConnectionTokens` was scoped by `expertProfileId` ALONE, so with a Cronofy row
   * AND an Apiroc row live for one expert, refreshing the Cronofy connection's tokens would
   * ALSO write those tokens onto the Apiroc row's (previously NULL) token columns —
   * corrupting a connection this write was never meant to touch. Provider scoping must
   * leave the sibling connection completely untouched, not merely "still present".
   */
  it('does NOT touch a sibling connection for a different provider on the same expert (A2 regression)', async () => {
    const expert = await expertDraftFactory();
    await calendarRepository.upsertConnection(cronofyInput(expert.id, 'google'));
    await insertApirocConnection(expert.id, 'microsoft', 'eua-untouched');

    await calendarRepository.updateConnectionTokens(expert.id, 'google', {
      accessToken: 'enc_rotated_google_only',
      refreshToken: 'enc_rotated_google_refresh',
      tokenExpiresAt: new Date('2098-06-01T00:00:00.000Z'),
    });

    const google = await calendarRepository.findConnectionByExpertAndProvider(expert.id, 'google');
    expect(google?.accessToken).toBe('enc_rotated_google_only');

    const microsoft = await calendarRepository.findConnectionByExpertAndProvider(
      expert.id,
      'microsoft'
    );
    expect(microsoft?.endUserAccountId).toBe('eua-untouched');
    expect(microsoft?.accessToken).toBeNull();
    expect(microsoft?.refreshToken).toBeNull();
    expect(microsoft?.tokenExpiresAt).toBeNull();
  });
});
