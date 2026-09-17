import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  PLATFORM_CAPABILITIES,
  STAFF_ACCESS_AUDIT_ACTIONS,
  resolvePlatformCapabilities,
  type PlatformCapability,
  type StaffAccessSaveRefusal,
} from '@balo/shared/authz';
import { db } from '../client';
import { auditEvents, users, type NewUser } from '../schema';
import { userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { auditEventsRepository } from './audit-events';
import { usersRepository, type SaveStaffAccessInput } from './users';

/**
 * BAL-561 — the Staff access repository surface: `saveStaffAccess` (THE ONE production writer of
 * `platform_role` + `platform_capabilities`), `findStaffCandidateByEmail`, `listStaffAccessRoster`,
 * and the `users_email_lower_unique` index (D1) the email lookup relies on.
 *
 * Runs on the standard harness (one rolled-back transaction per test). Genuine races cannot be
 * expressed here — they live in `users.staff-access.concurrency.integration.test.ts`.
 *
 * ⚠ EVERY REFUSAL TEST ASSERTS THREE THINGS: the named reason, the target row UNCHANGED, and ZERO
 * audit rows for the target (a length assertion). A refusal that wrote an audit row, or wrote the
 * row and then reported a refusal, would pass a reason-only assertion.
 */

const CAP = PLATFORM_CAPABILITIES;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * F1 — defaults `emailVerified: true`, unlike the bare schema default (`false`), because every
 * fixture in this file models an EXISTING staff member being managed, not a fresh signup. Tests
 * that specifically exercise the F1 ineligibility path override it back to `false` (or use
 * `status: 'suspended'`) explicitly.
 */
async function staff(
  role: NewUser['platformRole'],
  overrides: Partial<NewUser> = {}
): Promise<string> {
  const user = await userFactory({ platformRole: role, emailVerified: true, ...overrides });
  return user.id;
}

async function setCustomList(userId: string, list: PlatformCapability[] | null): Promise<void> {
  await db.update(users).set({ platformCapabilities: list }).where(eq(users.id, userId));
}

/** The stored pair, read straight off the row. */
async function storedAccess(
  userId: string
): Promise<{ platformRole: string; platformCapabilities: unknown }> {
  const [row] = await db
    .select({ platformRole: users.platformRole, platformCapabilities: users.platformCapabilities })
    .from(users)
    .where(eq(users.id, userId));
  if (row === undefined) throw new Error(`user ${userId} not found`);
  return row;
}

/**
 * RAW SQL on purpose: Drizzle maps both SQL NULL and JSON `null` to JS `null`, so only the database
 * can say which one is stored. `null` (follows the role) must be SQL NULL.
 */
async function rawOverrideShape(
  userId: string
): Promise<{ is_sql_null: boolean; json_type: string | null }> {
  const result = await db.execute<{ is_sql_null: boolean; json_type: string | null }>(
    sql`SELECT platform_capabilities IS NULL AS is_sql_null, jsonb_typeof(platform_capabilities) AS json_type FROM users WHERE id = ${userId}::uuid`
  );
  const [row] = result;
  if (row === undefined) throw new Error(`user ${userId} not found`);
  return row;
}

/** Every audit row naming this user as the entity, oldest first. */
async function auditRowsFor(userId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, 'user'), eq(auditEvents.entityId, userId)))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function expectRefused(
  input: SaveStaffAccessInput,
  reason: StaffAccessSaveRefusal,
  unchanged: { role: string; customList: PlatformCapability[] | null }
): Promise<void> {
  await expect(usersRepository.saveStaffAccess(input)).resolves.toEqual({
    outcome: 'refused',
    reason,
  });
  // N7 — these follow-up statements run in the SAME harness transaction: had the refusal been a
  // raw constraint violation, they would fail 25P02 instead of reading the row.
  expect(await storedAccess(input.targetUserId)).toEqual({
    platformRole: unchanged.role,
    platformCapabilities: unchanged.customList,
  });
  await expect(auditRowsFor(input.targetUserId)).resolves.toHaveLength(0);
}

/** The admin bundle, via the shared resolver (the D9 pre-fill), canonically ordered. */
function canonical(tokens: readonly PlatformCapability[]): PlatformCapability[] {
  const wanted = new Set(tokens);
  return Object.values(PLATFORM_CAPABILITIES).filter((token) => wanted.has(token));
}

describe('usersRepository.saveStaffAccess — writes', () => {
  it('promotes user → admin: role written, list SQL NULL, ONE role audit row, visible to session sync (D8)', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('user');

    const result = await usersRepository.saveStaffAccess({
      actorUserId,
      targetUserId,
      expected: { role: 'user', customList: null },
      next: { role: 'admin', customList: null },
    });

    expect(result).toMatchObject({ outcome: 'saved', roleChanged: true, customListChanged: false });
    expect(await storedAccess(targetUserId)).toEqual({
      platformRole: 'admin',
      platformCapabilities: null,
    });
    expect(await rawOverrideShape(targetUserId)).toEqual({ is_sql_null: true, json_type: null });

    const rows = await auditRowsFor(targetUserId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      actorUserId,
      action: STAFF_ACCESS_AUDIT_ACTIONS.ROLE_CHANGED,
      entityType: 'user',
      entityId: targetUserId,
      metadata: { from: 'user', to: 'admin' },
    });
    expect(result.outcome === 'saved' ? result.auditEventIds : []).toEqual([row?.id]);

    // D8 — the session-sync projection (what `checkSessionDrift` compares) now reports the change.
    expect(await usersRepository.findForSessionSync(targetUserId)).toMatchObject({
      platformRole: 'admin',
      platformCapabilities: null,
    });
  });

  it('"an admin, minus promo codes": stores the list de-duplicated in canonical order, ONE list audit row, no role row', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin');
    const bundle = resolvePlatformCapabilities('admin', null);
    const minusPromo = bundle.filter((token) => token !== CAP.MANAGE_PROMO_CODES);
    expect(minusPromo).toHaveLength(bundle.length - 1);
    const expectedStored = canonical(minusPromo);

    const result = await usersRepository.saveStaffAccess({
      actorUserId,
      targetUserId,
      expected: { role: 'admin', customList: null },
      // Reversed and with a duplicate — the save must normalise, not store what it was handed.
      next: {
        role: 'admin',
        customList: [...minusPromo].reverse().concat(CAP.VIEW_PLATFORM_ADMIN),
      },
    });

    expect(result).toMatchObject({ outcome: 'saved', roleChanged: false, customListChanged: true });
    expect(await storedAccess(targetUserId)).toEqual({
      platformRole: 'admin',
      platformCapabilities: expectedStored,
    });

    const rows = await auditRowsFor(targetUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId,
      action: STAFF_ACCESS_AUDIT_ACTIONS.CUSTOM_LIST_SET,
      metadata: { from: null, to: expectedStored },
    });
    expect(rows.filter((r) => r.action === STAFF_ACCESS_AUDIT_ACTIONS.ROLE_CHANGED)).toHaveLength(
      0
    );

    // D8 — and session sync sees the list.
    expect(await usersRepository.findForSessionSync(targetUserId)).toMatchObject({
      platformRole: 'admin',
      platformCapabilities: expectedStored,
    });
  });

  it('ruling 1: a super_admin on a list holding the token → admin following the role writes BOTH rows and never trips the CHECK', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('super_admin');
    const stored = [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES];
    await setCustomList(targetUserId, stored);

    const result = await usersRepository.saveStaffAccess({
      actorUserId,
      targetUserId,
      expected: { role: 'super_admin', customList: stored },
      next: { role: 'admin', customList: null },
    });

    expect(result).toMatchObject({ outcome: 'saved', roleChanged: true, customListChanged: true });
    expect(await rawOverrideShape(targetUserId)).toEqual({ is_sql_null: true, json_type: null });
    expect((await storedAccess(targetUserId)).platformRole).toBe('admin');

    const rows = await auditRowsFor(targetUserId);
    expect(rows.map((r) => r.action)).toEqual([
      STAFF_ACCESS_AUDIT_ACTIONS.ROLE_CHANGED,
      STAFF_ACCESS_AUDIT_ACTIONS.CUSTOM_LIST_SET,
    ]);
    expect(rows[0]?.metadata).toEqual({ from: 'super_admin', to: 'admin' });
    expect(rows[1]?.metadata).toEqual({ from: stored, to: null });
    // The returned ids are the rows actually written, role row first.
    expect(result.outcome === 'saved' ? result.auditEventIds : []).toEqual(rows.map((r) => r.id));
  });

  it('a role change re-customised in the same save (admin list → super_admin list with the token) writes both rows', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin');
    const before = [CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN];
    await setCustomList(targetUserId, before);
    const after = [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES];

    const result = await usersRepository.saveStaffAccess({
      actorUserId,
      targetUserId,
      expected: { role: 'admin', customList: before },
      next: { role: 'super_admin', customList: after },
    });

    expect(result).toMatchObject({ outcome: 'saved', roleChanged: true, customListChanged: true });
    expect(await storedAccess(targetUserId)).toEqual({
      platformRole: 'super_admin',
      platformCapabilities: after,
    });
    const rows = await auditRowsFor(targetUserId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.metadata).toEqual({ from: before, to: after });
  });

  it('stores [] as a jsonb ARRAY (holds nothing), and clearing it back stores SQL NULL (follows the role)', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin');

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'admin', customList: null },
        next: { role: 'admin', customList: [] },
      })
    ).resolves.toMatchObject({ outcome: 'saved', customListChanged: true });
    expect(await rawOverrideShape(targetUserId)).toEqual({
      is_sql_null: false,
      json_type: 'array',
    });
    expect((await storedAccess(targetUserId)).platformCapabilities).toEqual([]);

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'admin', customList: [] },
        next: { role: 'admin', customList: null },
      })
    ).resolves.toMatchObject({ outcome: 'saved', customListChanged: true });
    expect(await rawOverrideShape(targetUserId)).toEqual({ is_sql_null: true, json_type: null });

    const rows = await auditRowsFor(targetUserId);
    expect(rows.map((r) => r.metadata)).toEqual([
      { from: null, to: [] },
      { from: [], to: null },
    ]);
  });

  it('composes under a caller transaction (exec param) and rolls back with it', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('user');

    await expect(
      db.transaction(async (tx) => {
        const result = await usersRepository.saveStaffAccess(
          {
            actorUserId,
            targetUserId,
            expected: { role: 'user', customList: null },
            next: { role: 'admin', customList: null },
          },
          tx
        );
        expect(result).toMatchObject({ outcome: 'saved' });
        throw new Error('caller rolls back');
      })
    ).rejects.toThrow('caller rolls back');

    expect((await storedAccess(targetUserId)).platformRole).toBe('user');
    await expect(auditRowsFor(targetUserId)).resolves.toHaveLength(0);
  });
});

describe('usersRepository.saveStaffAccess — refusals (reason + row unchanged + zero audit rows)', () => {
  it('D3 self_edit: every save on the actor’s own record is refused', async () => {
    const actorUserId = await staff('super_admin');
    await staff('super_admin'); // a second holder, so only D3 can be the reason

    await expectRefused(
      {
        actorUserId,
        targetUserId: actorUserId,
        expected: { role: 'super_admin', customList: null },
        next: { role: 'super_admin', customList: [CAP.VIEW_PLATFORM_ADMIN] },
      },
      'self_edit',
      { role: 'super_admin', customList: null }
    );
  });

  it('actor_not_authorized: an admin, a suspended super_admin, a soft-deleted super_admin, and a super_admin whose list lacks the token', async () => {
    await staff('super_admin'); // a live floor holder, so the floor is never the reason
    const suspended = await staff('super_admin', { status: 'suspended' });
    const deleted = await staff('super_admin');
    await usersRepository.softDelete(deleted);
    const noToken = await staff('super_admin');
    await setCustomList(noToken, [CAP.VIEW_PLATFORM_ADMIN]);
    const actors = [await staff('admin'), suspended, deleted, noToken];
    expect(actors).toHaveLength(4);

    for (const actorUserId of actors) {
      const targetUserId = await staff('admin');
      await expectRefused(
        {
          actorUserId,
          targetUserId,
          expected: { role: 'admin', customList: null },
          next: { role: 'super_admin', customList: null },
        },
        'actor_not_authorized',
        { role: 'admin', customList: null }
      );
    }
  });

  it('target_not_found: an unknown id, and a soft-deleted account', async () => {
    const actorUserId = await staff('super_admin');

    const unknown = randomUUID();
    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId: unknown,
        expected: { role: 'user', customList: null },
        next: { role: 'admin', customList: null },
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'target_not_found' });
    await expect(auditRowsFor(unknown)).resolves.toHaveLength(0);

    const deleted = await staff('user');
    await usersRepository.softDelete(deleted);
    await expectRefused(
      {
        actorUserId,
        targetUserId: deleted,
        expected: { role: 'user', customList: null },
        next: { role: 'admin', customList: null },
      },
      'target_not_found',
      { role: 'user', customList: null }
    );
  });

  it('D6 stale: the reviewed role differs from the stored row', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin');

    await expectRefused(
      {
        actorUserId,
        targetUserId,
        expected: { role: 'user', customList: null },
        next: { role: 'super_admin', customList: null },
      },
      'stale',
      { role: 'admin', customList: null }
    );
  });

  it('D6 stale: the reviewed list differs from the stored row — null reviewed, [] stored', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin');
    await setCustomList(targetUserId, []);

    await expectRefused(
      {
        actorUserId,
        targetUserId,
        expected: { role: 'admin', customList: null },
        next: { role: 'admin', customList: [CAP.VIEW_PLATFORM_ADMIN] },
      },
      'stale',
      { role: 'admin', customList: [] }
    );
  });

  it('no_change: the draft equals the stored pair', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin');
    const stored = [CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN];
    await setCustomList(targetUserId, stored);

    await expectRefused(
      {
        actorUserId,
        targetUserId,
        expected: { role: 'admin', customList: stored },
        next: { role: 'admin', customList: [...stored].reverse() },
      },
      'no_change',
      { role: 'admin', customList: stored }
    );
  });

  it('draft refusals, before any write: unknown_capability, custom_list_requires_staff_role, staff_management_requires_super_admin', async () => {
    const actorUserId = await staff('super_admin');
    const cases: readonly {
      readonly next: SaveStaffAccessInput['next'];
      readonly reason: StaffAccessSaveRefusal;
    }[] = [
      {
        next: { role: 'admin', customList: [CAP.VIEW_PLATFORM_ADMIN, 'a_retired_token'] },
        reason: 'unknown_capability',
      },
      { next: { role: 'user', customList: [] }, reason: 'custom_list_requires_staff_role' },
      {
        next: { role: 'admin', customList: [CAP.MANAGE_STAFF_CAPABILITIES] },
        reason: 'staff_management_requires_super_admin',
      },
    ];
    expect(cases).toHaveLength(3);

    for (const { next, reason } of cases) {
      const targetUserId = await staff('admin');
      await expectRefused(
        { actorUserId, targetUserId, expected: { role: 'admin', customList: null }, next },
        reason,
        { role: 'admin', customList: null }
      );
    }
  });

  it('F1 (S1/S2) target_ineligible: promoting a SUSPENDED user to admin, and an UNVERIFIED user to admin', async () => {
    const actorUserId = await staff('super_admin');
    const suspended = await staff('user', { status: 'suspended' });
    const unverified = await staff('user', { emailVerified: false });

    for (const targetUserId of [suspended, unverified]) {
      await expectRefused(
        {
          actorUserId,
          targetUserId,
          expected: { role: 'user', customList: null },
          next: { role: 'admin', customList: null },
        },
        'target_ineligible',
        { role: 'user', customList: null }
      );
    }
  });

  it('F1: saves when REMOVING a token from a suspended admin’s custom list — a pure reduction', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('admin', {
      status: 'suspended',
      platformCapabilities: [CAP.RESOLVE_ADMIN_ALERTS, CAP.MANAGE_PROMO_CODES],
    });

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'admin', customList: [CAP.RESOLVE_ADMIN_ALERTS, CAP.MANAGE_PROMO_CODES] },
        next: { role: 'admin', customList: [CAP.RESOLVE_ADMIN_ALERTS] },
      })
    ).resolves.toMatchObject({ outcome: 'saved', customListChanged: true });
    expect((await storedAccess(targetUserId)).platformCapabilities).toEqual([
      CAP.RESOLVE_ADMIN_ALERTS,
    ]);
  });

  it('F1: saves DEMOTING a suspended super_admin while another live floor holder exists', async () => {
    const actorUserId = await staff('super_admin');
    await staff('super_admin'); // the other live floor holder
    const targetUserId = await staff('super_admin', { status: 'suspended' });

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'super_admin', customList: null },
        next: { role: 'admin', customList: null },
      })
    ).resolves.toMatchObject({ outcome: 'saved', roleChanged: true });
    expect((await storedAccess(targetUserId)).platformRole).toBe('admin');
  });

  it('C3 target_ineligible: a SUSPENDED user and an UNVERIFIED user moved to admin with customList: [] — resolved [] both sides', async () => {
    const actorUserId = await staff('super_admin');
    const suspended = await staff('user', { status: 'suspended' });
    const unverified = await staff('user', { emailVerified: false });

    for (const targetUserId of [suspended, unverified]) {
      await expectRefused(
        {
          actorUserId,
          targetUserId,
          expected: { role: 'user', customList: null },
          next: { role: 'admin', customList: [] },
        },
        'target_ineligible',
        { role: 'user', customList: null }
      );
    }
  });

  it('C4 grant_exceeds_actor: an actor restricted to MANAGE_STAFF_CAPABILITIES cannot grant IMPERSONATE_USER', async () => {
    const actorUserId = await staff('super_admin', {
      platformCapabilities: [CAP.MANAGE_STAFF_CAPABILITIES],
    });
    const targetUserId = await staff('super_admin', { platformCapabilities: [] });

    await expectRefused(
      {
        actorUserId,
        targetUserId,
        expected: { role: 'super_admin', customList: [] },
        next: { role: 'super_admin', customList: [CAP.IMPERSONATE_USER] },
      },
      'grant_exceeds_actor',
      { role: 'super_admin', customList: [] }
    );
  });

  it('C4: the SAME restricted actor CAN grant MANAGE_STAFF_CAPABILITIES — a ceiling, not a blanket freeze', async () => {
    const actorUserId = await staff('super_admin', {
      platformCapabilities: [CAP.MANAGE_STAFF_CAPABILITIES],
    });
    const targetUserId = await staff('super_admin', { platformCapabilities: [] });
    await staff('super_admin'); // bystander floor holder — neither actor nor target holds it

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'super_admin', customList: [] },
        next: { role: 'super_admin', customList: [CAP.MANAGE_STAFF_CAPABILITIES] },
      })
    ).resolves.toMatchObject({ outcome: 'saved', customListChanged: true });
    expect((await storedAccess(targetUserId)).platformCapabilities).toEqual([
      CAP.MANAGE_STAFF_CAPABILITIES,
    ]);
  });
});

describe('usersRepository.saveStaffAccess — the D2 floor, calling the mutator directly', () => {
  /**
   * Actor X is AUTHORISED (a super_admin whose list holds the token) but is NOT a floor holder (its
   * list lacks `view_platform_admin`), so the floor — not the actor re-check — is the only rule
   * that can refuse these saves. The precondition is asserted, not assumed, in every test.
   */
  async function floorFixture(): Promise<{ actorUserId: string; holder: string }> {
    const actorUserId = await staff('super_admin');
    await setCustomList(actorUserId, [CAP.MANAGE_STAFF_CAPABILITIES]);
    const holder = await staff('super_admin');
    return { actorUserId, holder };
  }

  /**
   * ⚠ THE PRECONDITION RESTATES D2 INDEPENDENTLY — it does NOT call
   * `accountKeepsStaffManagementFloor`. Asserting a fixture with the very predicate under test is
   * circular: break the predicate and the precondition breaks with it, so the refusal assertions
   * below would never be the thing that goes red. Here the rule is spelled out against the
   * resolver's whole set ("live, and holds BOTH tokens"), so a mutated floor predicate fails on the
   * save OUTCOME.
   */
  async function expectSoleFloorHolder(holder: string): Promise<void> {
    const holders = (await usersRepository.listStaffAccessRoster()).filter((person) => {
      const resolved = resolvePlatformCapabilities(person.role, person.customList);
      return (
        person.isLive &&
        resolved.includes(CAP.MANAGE_STAFF_CAPABILITIES) &&
        resolved.includes(CAP.VIEW_PLATFORM_ADMIN)
      );
    });
    expect(holders).toHaveLength(1);
    expect(holders[0]?.id).toBe(holder);
  }

  it('refuses demoting the sole holder', async () => {
    const { actorUserId, holder } = await floorFixture();
    await expectSoleFloorHolder(holder);

    await expectRefused(
      {
        actorUserId,
        targetUserId: holder,
        expected: { role: 'super_admin', customList: null },
        next: { role: 'admin', customList: null },
      },
      'floor_violation',
      { role: 'super_admin', customList: null }
    );
  });

  it('refuses removing manage_staff_capabilities from the sole holder’s list', async () => {
    const { actorUserId, holder } = await floorFixture();
    const both = [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES];
    await setCustomList(holder, both);
    await expectSoleFloorHolder(holder);

    await expectRefused(
      {
        actorUserId,
        targetUserId: holder,
        expected: { role: 'super_admin', customList: both },
        next: { role: 'super_admin', customList: [CAP.VIEW_PLATFORM_ADMIN] },
      },
      'floor_violation',
      { role: 'super_admin', customList: both }
    );
  });

  it('D2: refuses removing view_platform_admin from the sole holder’s list', async () => {
    const { actorUserId, holder } = await floorFixture();
    const both = [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES];
    await setCustomList(holder, both);
    await expectSoleFloorHolder(holder);

    await expectRefused(
      {
        actorUserId,
        targetUserId: holder,
        expected: { role: 'super_admin', customList: both },
        next: { role: 'super_admin', customList: [CAP.MANAGE_STAFF_CAPABILITIES] },
      },
      'floor_violation',
      { role: 'super_admin', customList: both }
    );
  });

  it('a SUSPENDED second super_admin does not rescue the floor', async () => {
    const { actorUserId, holder } = await floorFixture();
    await staff('super_admin', { status: 'suspended' });
    await expectSoleFloorHolder(holder);

    await expectRefused(
      {
        actorUserId,
        targetUserId: holder,
        expected: { role: 'super_admin', customList: null },
        next: { role: 'admin', customList: null },
      },
      'floor_violation',
      { role: 'super_admin', customList: null }
    );
  });

  it('a LIVE second holder lets the same demotion save', async () => {
    const { actorUserId, holder } = await floorFixture();
    await expectSoleFloorHolder(holder);
    await staff('super_admin');

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId: holder,
        expected: { role: 'super_admin', customList: null },
        next: { role: 'admin', customList: null },
      })
    ).resolves.toMatchObject({ outcome: 'saved', roleChanged: true });
    expect((await storedAccess(holder)).platformRole).toBe('admin');
    await expect(auditRowsFor(holder)).resolves.toHaveLength(1);
  });
});

describe('usersRepository.saveStaffAccess — atomicity (ADR-1030)', () => {
  it('a failing audit write rolls the role change back: row unchanged, zero audit rows', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('user');
    vi.spyOn(auditEventsRepository, 'record').mockRejectedValueOnce(new Error('boom'));

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'user', customList: null },
        next: { role: 'admin', customList: null },
      })
    ).rejects.toThrow('boom');

    expect(await storedAccess(targetUserId)).toEqual({
      platformRole: 'user',
      platformCapabilities: null,
    });
    await expect(auditRowsFor(targetUserId)).resolves.toHaveLength(0);
  });

  it('a failing SECOND audit write rolls back the pair AND the first audit row it already inserted', async () => {
    const actorUserId = await staff('super_admin');
    const targetUserId = await staff('super_admin');
    const stored = [CAP.VIEW_PLATFORM_ADMIN];
    await setCustomList(targetUserId, stored);
    const real = auditEventsRepository.record;
    const spy = vi.spyOn(auditEventsRepository, 'record');
    spy.mockImplementationOnce(real).mockRejectedValueOnce(new Error('boom'));

    await expect(
      usersRepository.saveStaffAccess({
        actorUserId,
        targetUserId,
        expected: { role: 'super_admin', customList: stored },
        next: { role: 'admin', customList: null },
      })
    ).rejects.toThrow('boom');

    // Non-vacuity: the first (role) row really was inserted before the second write failed.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await storedAccess(targetUserId)).toEqual({
      platformRole: 'super_admin',
      platformCapabilities: stored,
    });
    await expect(auditRowsFor(targetUserId)).resolves.toHaveLength(0);
  });
});

describe('usersRepository.findStaffCandidateByEmail (ruling 3)', () => {
  function uniqueEmail(): string {
    return `dana-${randomUUID()}@northwind.test`;
  }

  it('returns exactly the projected key set for an exact match — no workosId, no phone', async () => {
    const email = uniqueEmail();
    const id = await staff('user', {
      email,
      firstName: 'Dana',
      lastName: 'Reyes',
      phone: '+61400000001',
    });

    const found = await usersRepository.findStaffCandidateByEmail(email);

    expect(found).toEqual({
      id,
      firstName: 'Dana',
      lastName: 'Reyes',
      email,
      emailVerified: true,
      role: 'user',
      customList: null,
      isLive: true,
    });
    expect(Object.keys(found ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'customList',
      'email',
      'emailVerified',
      'firstName',
      'id',
      'isLive',
      'lastName',
      'role',
    ]);
  });

  it('matches case-insensitively in both directions', async () => {
    const email = uniqueEmail();
    const id = await staff('user', { email });
    expect((await usersRepository.findStaffCandidateByEmail(email.toUpperCase()))?.id).toBe(id);

    const mixed = `Mixed-${randomUUID()}@Northwind.TEST`;
    const mixedId = await staff('user', { email: mixed });
    expect((await usersRepository.findStaffCandidateByEmail(mixed.toLowerCase()))?.id).toBe(
      mixedId
    );
  });

  it('returns a staff account with its NORMALISED list', async () => {
    const email = uniqueEmail();
    await staff('admin', { email });
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (row === undefined) throw new Error('fixture');
    await db.execute(
      sql`UPDATE users SET platform_capabilities = '["view_platform_admin","view_platform_admin","retired_x"]'::jsonb WHERE id = ${row.id}::uuid`
    );

    expect(await usersRepository.findStaffCandidateByEmail(email)).toMatchObject({
      role: 'admin',
      customList: [CAP.VIEW_PLATFORM_ADMIN],
    });
  });

  it('returns nothing for a partial address — equality only', async () => {
    const local = `dana-${randomUUID()}`;
    await staff('user', { email: `${local}@northwind.test` });
    const partials = [`${local}@northwind`, local, `${local.slice(1)}@northwind.test`, `${local}@`];
    expect(partials).toHaveLength(4);

    for (const partial of partials) {
      await expect(usersRepository.findStaffCandidateByEmail(partial)).resolves.toBeUndefined();
    }
  });

  it('returns nothing for a soft-deleted or a suspended account', async () => {
    const deletedEmail = uniqueEmail();
    const deleted = await staff('user', { email: deletedEmail });
    await usersRepository.softDelete(deleted);
    await expect(usersRepository.findStaffCandidateByEmail(deletedEmail)).resolves.toBeUndefined();

    const suspendedEmail = uniqueEmail();
    await staff('user', { email: suspendedEmail, status: 'suspended' });
    await expect(
      usersRepository.findStaffCandidateByEmail(suspendedEmail)
    ).resolves.toBeUndefined();
  });

  it('F1 (S1/S2) — returns nothing for a live, active, but UNVERIFIED account — the same generic miss', async () => {
    const unverifiedEmail = uniqueEmail();
    await staff('user', { email: unverifiedEmail, emailVerified: false });
    await expect(
      usersRepository.findStaffCandidateByEmail(unverifiedEmail)
    ).resolves.toBeUndefined();
  });
});

describe('users_email_lower_unique (D1) — what makes the lookup’s LIMIT 1 safe', () => {
  it('rejects a LIVE case-variant of an existing email with 23505 on exactly this index', async () => {
    const email = `case-${randomUUID()}@northwind.test`;
    await staff('user', { email });

    await expectConstraintViolation(
      '23505',
      (tx) =>
        tx.insert(users).values({
          workosId: `wos-${randomUUID()}`,
          email: email.toUpperCase(),
        }),
      'users_email_lower_unique'
    );
  });

  it('allows the case-variant once the original is soft-deleted — the index is partial', async () => {
    const email = `case-${randomUUID()}@northwind.test`;
    const original = await staff('user', { email });
    await usersRepository.softDelete(original);

    const [created] = await db
      .insert(users)
      // F1 — a raw insert bypasses the `staff()` helper's `emailVerified: true` default; this
      // test is about the partial index, not F1, so it must set it explicitly or the new
      // `findStaffCandidateByEmail` verified-only filter would make it look like the miss F1's
      // OWN test already covers, for an unrelated reason.
      .values({ workosId: `wos-${randomUUID()}`, email: email.toUpperCase(), emailVerified: true })
      .returning({ id: users.id });
    expect(created?.id).toBeDefined();
    expect((await usersRepository.findStaffCandidateByEmail(email))?.id).toBe(created?.id);
  });
});

describe('usersRepository.listStaffAccessRoster', () => {
  it('returns staff only — excludes user rows and deleted rows, includes suspended staff as not live', async () => {
    const admin = await staff('admin');
    const superAdmin = await staff('super_admin');
    const suspended = await staff('admin', { status: 'suspended' });
    const plainUser = await staff('user');
    const deleted = await staff('super_admin');
    await usersRepository.softDelete(deleted);

    const roster = await usersRepository.listStaffAccessRoster();
    const ids = roster.map((person) => person.id);

    expect(ids).toEqual(expect.arrayContaining([admin, superAdmin, suspended]));
    expect(ids).not.toContain(plainUser);
    expect(ids).not.toContain(deleted);
    const mine = roster.filter((person) => [admin, superAdmin, suspended].includes(person.id));
    expect(mine).toHaveLength(3);
    expect(mine.find((person) => person.id === suspended)?.isLive).toBe(false);
    expect(mine.filter((person) => person.isLive)).toHaveLength(2);
  });

  it('projects exactly the Staff access key set', async () => {
    const id = await staff('admin');
    const person = (await usersRepository.listStaffAccessRoster()).find((p) => p.id === id);
    expect(Object.keys(person ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'customList',
      'email',
      'emailVerified',
      'firstName',
      'id',
      'isLive',
      'lastName',
      'role',
    ]);
  });

  it('normalises a stored list with duplicates and a retired token', async () => {
    const id = await staff('admin');
    await db.execute(
      sql`UPDATE users SET platform_capabilities = '["view_platform_admin","view_platform_admin","retired_x"]'::jsonb WHERE id = ${id}::uuid`
    );

    const person = (await usersRepository.listStaffAccessRoster()).find((p) => p.id === id);
    expect(person?.customList).toEqual([CAP.VIEW_PLATFORM_ADMIN]);
  });

  it('orders by first name, last name, then email', async () => {
    const tag = randomUUID();
    const zed = await staff('admin', {
      firstName: 'Bea',
      lastName: 'Zed',
      email: `a-${tag}@x.test`,
    });
    const xuB = await staff('admin', {
      firstName: 'Ada',
      lastName: 'Xu',
      email: `b-${tag}@x.test`,
    });
    const young = await staff('admin', {
      firstName: 'Ada',
      lastName: 'Young',
      email: `c-${tag}@x.test`,
    });
    // Same name as `xuB`, so only the email tiebreak orders these two.
    const xuA = await staff('admin', {
      firstName: 'Ada',
      lastName: 'Xu',
      email: `aa-${tag}@x.test`,
    });
    const seeded = new Set([zed, xuB, young, xuA]);

    const ordered = (await usersRepository.listStaffAccessRoster())
      .filter((person) => seeded.has(person.id))
      .map((person) => person.id);

    expect(ordered).toEqual([xuA, xuB, young, zed]);
  });
});
