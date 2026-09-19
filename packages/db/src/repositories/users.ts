import { eq, and, or, asc, isNull, inArray, gt, lte, sql } from 'drizzle-orm';
// BAL-541 — the ONE place the Balo-staff role set is spelled (ADR-1029). `listPlatformStaff`
// asks it who is eligible to be named a request owner; it never lists the roles itself.
// BAL-561 — the staff-access RULE MODULE. `saveStaffAccess` locks, hands the locked rows to
// `evaluateLockedStaffAccessSave`, and writes; every rule lives there, never as SQL here.
import {
  PLATFORM_STAFF_ROLES,
  STAFF_ACCESS_AUDIT_ACTIONS,
  evaluateLockedStaffAccessSave,
  precheckStaffAccessSave,
  storedCustomListOf,
  userRowIsLive,
  type StaffAccessPerson,
  type StaffAccessSaveRefusal,
  type StaffAccessSaveRequest,
} from '@balo/shared/authz';
import { db } from '../client';
import {
  users,
  companies,
  companyMembers,
  expertProfiles,
  type User,
  type NewUser,
  type Company,
  type CompanyMember,
} from '../schema';
import { auditEventsRepository } from './audit-events';
import type { DbExecutor } from './_shared/db-executor';

/**
 * Platform-role enum values, derived from the inferred `users.platformRole`
 * column type so it stays in lock-step with the `platformRoleEnum` definition
 * (single source of truth) — same house style as the A6 proposal enum types.
 */
export type PlatformRole = User['platformRole'];

/** BAL-561 — one Staff access save. `actorUserId` comes from the SESSION, never the payload. */
export type SaveStaffAccessInput = StaffAccessSaveRequest;

/**
 * BAL-561 — a Staff access save's outcome. A business refusal is a VALUE, never a throw (the
 * `companiesRepository.setBillingEmail` posture); only a genuine database fault throws.
 */
export type SaveStaffAccessResult =
  | {
      readonly outcome: 'saved';
      readonly roleChanged: boolean;
      readonly customListChanged: boolean;
      /** The audit rows written in the save's transaction: role row first, then list row. */
      readonly auditEventIds: readonly string[];
    }
  | { readonly outcome: 'refused'; readonly reason: StaffAccessSaveRefusal };

/**
 * BAL-561 — the EXPLICIT projection every Staff access read and the save's lock read select.
 * Never a relational `with:` hydration (memory `reference_drizzle_with_hydration_leaks_secrets`):
 * `workosId` and `phone` cannot reach the page because this object cannot select them.
 */
const STAFF_ACCESS_ROW = {
  id: users.id,
  firstName: users.firstName,
  lastName: users.lastName,
  email: users.email,
  emailVerified: users.emailVerified,
  platformRole: users.platformRole,
  platformCapabilities: users.platformCapabilities,
  status: users.status,
  deletedAt: users.deletedAt,
} as const;

interface StaffAccessRow {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string;
  /** F1 (S1/S2) — read alongside `isLive` so `accountMayGainAccess` can be evaluated on this row. */
  readonly emailVerified: boolean;
  readonly platformRole: PlatformRole;
  /** jsonb — UNKNOWN-shaped whatever `$type` claims; normalised by `storedCustomListOf`. */
  readonly platformCapabilities: unknown;
  readonly status: string;
  readonly deletedAt: Date | null;
}

/**
 * Row → the shape every Staff access consumer sees: `role` and a NORMALISED `customList`, never
 * the column names. The web surface therefore never holds a raw stored override (PIN C in
 * `platform-capability-single-resolution-point.test.ts` measures exactly that).
 */
function toStaffAccessPerson(row: StaffAccessRow): StaffAccessPerson {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    emailVerified: row.emailVerified,
    role: row.platformRole,
    customList: storedCustomListOf(row.platformRole, row.platformCapabilities),
    isLive: userRowIsLive(row),
  };
}

export const usersRepository = {
  /**
   * Find user by internal UUID (excludes soft-deleted)
   */
  findById: async (id: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: and(eq(users.id, id), isNull(users.deletedAt)),
    });
  },

  /**
   * Find user by WorkOS ID (used in auth callback, excludes soft-deleted)
   */
  findByWorkosId: async (workosId: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: and(eq(users.workosId, workosId), isNull(users.deletedAt)),
    });
  },

  /**
   * ⚠⚠ BAL-568 ADDED A `findSoftDeletedByWorkosId` HERE AND FIX ROUND 1 REMOVED IT. DO NOT
   * RE-ADD IT — not without an index and a deliberate decision.
   *
   * It filtered `deleted_at IS NOT NULL`, which CANNOT use `users_workos_id_unique` (that index is
   * PARTIAL, `WHERE deleted_at IS NULL`), so every call SEQ-SCANNED `users`. It sat on the
   * authentication hot path, and `apps/api`'s `requireAuth` runs BEFORE the rate limiter on every
   * route that has one — so a replayed soft-deleted token drove unthrottled full-table scans, at
   * whatever rate the caller chose. The original design rejected a supporting index on DBA effort;
   * it never weighed attacker-controlled scan rate, which is what actually decided this.
   *
   * ⚠ THE CONSEQUENCE IS DELIBERATE AND IS DOCUMENTED AT `apps/api/src/lib/require-auth.ts`: a
   * soft-deleted account and an unknown `sub` are now indistinguishable to the API, so the API path
   * emits only `account_suspended` and never `account_deleted`. Both are still REFUSED — the
   * difference is only whether the 401 carries the teardown marker. The page and action paths keep
   * emitting BOTH codes, because `findForSessionSync` below deliberately does not filter
   * `deletedAt` and so still returns soft-deleted rows.
   */

  /**
   * Find user by email (excludes soft-deleted)
   */
  findByEmail: async (email: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: and(eq(users.email, email), isNull(users.deletedAt)),
    });
  },

  /**
   * Find user with their company membership (for session hydration, excludes soft-deleted).
   *
   * BAL-345: the global unique on `company_members.userId` was dropped, so a user
   * may hold more than one live membership. Session consumers read
   * `companyMemberships[0]`, so this read MUST be deterministic: filter out
   * soft-removed memberships and order `[role, joinedAt, id]`. `role` is a NATIVE
   * pg enum (`owner|admin|member`) ordered by DECLARATION order, so `asc(role)`
   * puts the user's own personal-workspace `owner` row FIRST — the session lands
   * in the personal workspace, never a domain-joined secondary org.
   */
  findWithCompany: async (id: string) => {
    return db.query.users.findFirst({
      where: and(eq(users.id, id), isNull(users.deletedAt)),
      with: {
        companyMemberships: {
          where: (m, { isNull: isNullOp }) => isNullOp(m.deletedAt),
          orderBy: (m, { asc }) => [asc(m.role), asc(m.joinedAt), asc(m.id)],
          with: { company: true },
        },
      },
    });
  },

  /**
   * Find user by internal UUID including soft-deleted users
   */
  findByIdIncludingDeleted: async (id: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, id),
    });
  },

  /**
   * Soft-delete a user by setting deletedAt to the current timestamp
   */
  softDelete: async (id: string): Promise<User> => {
    const [user] = await db
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user!;
  },

  /**
   * Find minimal user fields for session sync comparison.
   * Intentionally does NOT filter deletedAt — needs to detect deleted users.
   * Returns: status, activeMode, platformRole, platformCapabilities, onboardingCompleted,
   * deletedAt, expertProfileId, activeCompanyId, expertApprovedAt, verticalId.
   * (The list is pinned as an exact key SET by `users.integration.test.ts`.)
   *
   * The projection is EXPLICIT on purpose — never a relational `with:` hydration,
   * which would materialise `workosId` / `email` / `phone` into a session-bound
   * read (memory `reference_drizzle_with_hydration_leaks_secrets`).
   *
   * BAL-494 widened it by two columns, purely additively:
   * - `activeCompanyId` — the STORED company-workspace choice (half of the
   *   `(active_mode, active_company_id)` workspace pair).
   * - `expertApprovedAt` — taken from the SAME left-joined `expert_profiles` row
   *   that already produces `expertProfileId`, so the derived expert workspace and
   *   the session's `expertProfileId` can never point at different profiles.
   *
   * BAL-553 widened it by a THIRD column, from the SAME left-joined row: `verticalId`.
   * `buildImpersonatedSessionUser` (`apps/web`) needs it to seal the impersonated TARGET's own
   * `SessionUser.verticalId` in one round trip rather than a second query — the left join
   * already produces it for free. The pre-BAL-553 "deliberately NOT selected, nothing consumes
   * it" reasoning no longer holds now that a real consumer exists.
   *
   * BAL-560 widened it by a FOURTH column: `platformCapabilities` — the per-user platform
   * capability override (ADR-1035 §A1.2). It is in this projection for the same reason
   * `platformRole` is: the session SEALS it, so `checkSessionDrift` must be able to notice a
   * revoked or changed override. Without it an override would go stale for the full 7-day
   * cookie lifetime while the role stayed in sync — worse than syncing neither. The
   * impersonation entry point (`apps/web/src/lib/auth/actions/impersonation.ts`) reads it from
   * here too, precisely because that gate deliberately re-reads the ACTOR live rather than
   * trusting a cookie that may be seven days stale.
   *
   * ⚠ Treat the value as UNKNOWN-shaped. `$type<PlatformCapability[]>()` on a jsonb column is a
   * compile-time claim Postgres does not enforce; the table CHECK
   * `users_platform_capabilities_staff_array` pins only the SHAPE (array-or-NULL) and the
   * role pairing. The ELEMENTS are filtered on the read path by `resolvePlatformCapabilities`
   * (`@balo/shared/authz`), so never hand this value to a gate without going through it.
   *
   * ⚠ Known pre-existing wart, deliberately NOT fixed here: the left join +
   * `.limit(1)` picks an arbitrary profile when a user holds profiles in several
   * verticals. `expertProfileId` already inherits it; adding an ORDER BY would
   * change drift behaviour on a shared seam for no ticket-scoped gain.
   */
  findForSessionSync: async (id: string) => {
    const rows = await db
      .select({
        status: users.status,
        activeMode: users.activeMode,
        platformRole: users.platformRole,
        platformCapabilities: users.platformCapabilities, // BAL-560
        onboardingCompleted: users.onboardingCompleted,
        deletedAt: users.deletedAt,
        expertProfileId: expertProfiles.id,
        activeCompanyId: users.activeCompanyId,
        expertApprovedAt: expertProfiles.approvedAt,
        verticalId: expertProfiles.verticalId,
      })
      .from(users)
      .leftJoin(expertProfiles, eq(expertProfiles.userId, users.id))
      .where(eq(users.id, id))
      .limit(1);

    return rows[0] ?? null;
  },

  /**
   * Batch lookup for notification fan-out (BAL-289): every non-deleted user id
   * whose platformRole is in `roles` (e.g. admins + super_admins). Returns the
   * ids in no particular order; an empty `roles` array yields an empty result.
   */
  findIdsByPlatformRoles: async (roles: PlatformRole[]): Promise<string[]> => {
    if (roles.length === 0) return [];
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.platformRole, roles), isNull(users.deletedAt)));
    return rows.map((r) => r.id);
  },

  /**
   * BAL-541 — THE BALO-STAFF ROSTER: every live user eligible to be named a request's Balo
   * owner, with the identity an owner picker needs.
   *
   * ⚠ A SEPARATE METHOD RATHER THAN A WIDENING OF {@link usersRepository.findIdsByPlatformRoles}.
   * That one exists for notification fan-out, returns bare ids, and has ONE caller; giving it a
   * second, differently-shaped audience would make each caller pay for the other's columns.
   *
   * ⚠ EXPLICIT `.select()` PROJECTION, NEVER A RELATIONAL `with:` — a hydrated `users` row
   * carries `workosId`, `phone` and the rest (memory
   * `reference_drizzle_with_hydration_leaks_secrets`). Only `id`/`firstName`/`lastName` are
   * projected — no consumer needs `email` or `platformRole`, so neither is selected.
   *
   * The role set comes from `PLATFORM_STAFF_ROLES`, the ONE interpretation point (ADR-1029), so
   * this roster and `assignOwner`'s in-transaction eligibility check can never disagree about
   * who counts as staff. Ordered by name so the picker is stable between renders.
   */
  listPlatformStaff: async (): Promise<
    Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
    }>
  > => {
    return db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(
        and(
          inArray(users.platformRole, [...PLATFORM_STAFF_ROLES] as PlatformRole[]),
          isNull(users.deletedAt)
        )
      )
      .orderBy(asc(users.firstName), asc(users.lastName));
  },

  /**
   * BAL-561 — THE STAFF ACCESS ROSTER: every non-deleted account holding a staff role, with its
   * normalised access.
   *
   * ⚠ A NEW METHOD, NOT A WIDENING OF {@link usersRepository.listPlatformStaff} — that one's
   * docblock asks for exactly this, and its owner picker needs neither `email` nor access.
   *
   * ⚠ SUSPENDED STAFF ARE INCLUDED, with `isLive: false`. The save transaction's floor counts
   * them as non-holders, and the page's floor preview must see the same set to agree with it; the
   * UI marks them. Soft-deleted accounts are excluded (no Staff access action can reach one).
   *
   * Ordered by first name, last name, email, then id — total, so the roster is stable between
   * renders even for two people with the same name. No index serves `platform_role`, exactly like
   * `findIdsByPlatformRoles`; this is a rare admin read over a small set.
   */
  listStaffAccessRoster: async (): Promise<StaffAccessPerson[]> => {
    const rows = await db
      .select(STAFF_ACCESS_ROW)
      .from(users)
      .where(
        and(
          inArray(users.platformRole, [...PLATFORM_STAFF_ROLES] as PlatformRole[]),
          isNull(users.deletedAt)
        )
      )
      .orderBy(asc(users.firstName), asc(users.lastName), asc(users.email), asc(users.id));
    return rows.map(toStaffAccessPerson);
  },

  /**
   * BAL-561 (ruling 3) — find the ONE live, active account with exactly this email, compared
   * case-insensitively, for "Give someone access". `undefined` for anything else.
   *
   * ⚠⚠ `LIMIT 1` IS SAFE ONLY BECAUSE OF `users_email_lower_unique` (D1, P2). That partial unique
   * index on `lower(email) WHERE deleted_at IS NULL` makes "at most one live account per
   * lower(email)" true by construction, so there is no second row for `LIMIT 1` to hide and no
   * two-match refusal is needed. It is pinned by the 23505 case in
   * `users.staff-access.integration.test.ts`. Drop the index and this query could promote an
   * arbitrary one of two case-variant accounts — a security write landing on the wrong person.
   *
   * CALLER CONTRACT: pass the input TRIMMED and do NOT lowercase it in JavaScript. `lower()` on
   * both sides in Postgres is exactly the index expression, so this lookup and the index agree on
   * what "the same email" means; a JS `toLowerCase()` folds some characters differently (the
   * mismatch `meeting-guests.ts` guards against). Equality only — no partial or prefix match.
   *
   * ⚠ SUSPENDED ACCOUNTS ARE EXCLUDED (`status = 'active'`), as are soft-deleted ones: both get the
   * same `undefined` a miss does, so the lookup reveals nothing beyond "a live account exists".
   * The action that calls this is live-gated for that reason.
   *
   * ⚠ UNVERIFIED EMAILS ARE EXCLUDED TOO (F1 / S1, S2), for the SAME generic-miss reason: staff
   * access is the most privileged email-based grant in the product, and every OTHER email-based
   * grant (`run-domain-join.ts`, `resolve-actionable-company.ts`, `resolve-identity.ts`) already
   * refuses an unverified email. This lookup is how a NEW promotion is found, so it is the STRONGER
   * of the two F1 checks — `saveStaffAccess`'s `accountMayGainAccess` is the backstop for a
   * candidate whose email was verified at lookup time but was un-verified (or suspended) by the
   * time the confirm dialog's save actually lands. An unverified account creates NO new oracle: it
   * reads exactly like a miss.
   *
   * Explicit projection (`STAFF_ACCESS_ROW`) — never `findByEmail`, which is case-sensitive and
   * returns the whole row, `workosId` and `phone` included.
   */
  findStaffCandidateByEmail: async (email: string): Promise<StaffAccessPerson | undefined> => {
    const [row] = await db
      .select(STAFF_ACCESS_ROW)
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = lower(${email})`,
          isNull(users.deletedAt),
          eq(users.status, 'active'),
          eq(users.emailVerified, true)
        )
      )
      .limit(1);
    return row === undefined ? undefined : toStaffAccessPerson(row);
  },

  /**
   * BAL-561 — SAVE ONE PERSON'S STAFF ACCESS: their `platform_role` and their custom list
   * (`platform_capabilities`) together, with the audit rows, in ONE transaction — or nothing.
   *
   * ⚠⚠ THE ONE PRODUCTION WRITER OF BOTH COLUMNS. Every production change to either column goes
   * through here. (The generic {@link usersRepository.update} can still set them; its only such
   * caller is the secret-gated E2E test-login route, pre-flight N1.)
   *
   * ⚠ F1 (S1 MEDIUM / S2 LOW) — A SAVE MAY ONLY *GRANT* A CAPABILITY TO A LIVE, EMAIL-VERIFIED
   * TARGET. `evaluateLockedStaffAccessSave` (`@balo/shared/authz`) computes the target's resolved
   * set before and after the draft and, if the draft ADDS anything — C3: including a plain
   * `user` moving to a staff role even when the resolved set is unchanged (`customList: []`) —
   * requires `accountMayGainAccess(target)`, the same bar every other email-based grant in the
   * product already holds (`run-domain-join.ts`, `resolve-actionable-company.ts`,
   * `resolve-identity.ts`). A PURE REDUCTION is never blocked by this: a suspended or unverified
   * staff member can still be demoted or trimmed. This closes a crafted-POST path where any
   * `targetUserId` could be promoted regardless of its live `status` — the api does not read
   * `status` today (BAL-568), so such a promotion would have taken effect there immediately.
   *
   * ⚠⚠ C4 (user-ruled) — A SAVE MAY ONLY *GRANT* A CAPABILITY THE ACTOR ITSELF RESOLVES. D3 stops
   * every self-edit, but without this an actor could promote a SECOND account to full
   * `super_admin` in one save, then use THAT account to restore the actor's own list in a second
   * save — never touching the actor's own record directly, so D3 never sees it. `grant_exceeds_actor`
   * refuses any draft whose added capabilities are not a subset of the ACTOR's own locked-row
   * resolved set (`staffAccessDraftGains`, shared with `saveBlockOf` — C7). Removals are
   * unaffected: a restricted actor can still demote or trim anyone. Intended consequence: a super
   * admin on a restricted custom list can no longer create a full super admin.
   *
   * Never throws for a business outcome: a refusal is `{ outcome: 'refused', reason }`. A real
   * database fault throws and the transaction rolls back. `exec` follows the
   * `reschedule-proposals.ts` precedent — a `Database` gets a real transaction, a transaction
   * handle gets a SAVEPOINT — which is how the concurrency suite drives it on its own connections.
   *
   * ORDER, and why each step sits where it does:
   *   1. `precheckStaffAccessSave` — synchronous, BEFORE the transaction: D3 refuses EVERY save on
   *      the actor's own record (self-reduction AND self-escalation), and the drafted pair is
   *      validated against the storage CHECK so a bad draft is a named refusal, never a raw 23514
   *      that would abort a caller's transaction (N7). No `await` precedes the transaction.
   *   2. LOCK every staff row + the target + the actor, `FOR NO KEY UPDATE`, ordered by id.
   *   3. `evaluateLockedStaffAccessSave` on the LOCKED rows, through the shared resolver — the
   *      actor re-check (M2/D6), the stale before-state check (D6), no-op, the F1 grant-eligibility
   *      check (`target_ineligible` — a live, email-verified target only, and only when the draft
   *      GAINS a capability), and the floor (D2), in that order. There is NO SQL copy of any rule
   *      (ADR-1029).
   *   4. ONE `UPDATE` writing role AND list — the CHECK's pair obligation (a role change over a
   *      list must clear or restate it in the same statement). A `null` list stores SQL NULL.
   *   5. The audit rows in the same transaction (ADR-1030, the `relinkWorkosId` shape): the
   *      role row (`{ from, to }` roles) first, then the list row (`{ from, to }` lists, `null` =
   *      follows the role). A role move whose list stays `null` writes only the role row.
   *
   * ⚠ THE LOCK SET IS A DELIBERATE SUPERSET. D6 names the target plus every `super_admin` row —
   * the only rows that can hold `MANAGE_STAFF_CAPABILITIES` (the CHECK keeps it off every other
   * row's list). Locking every STAFF row plus the target and the actor covers that set without a
   * role literal in `@balo/db` and without depending on the CHECK staying exactly as written, and
   * it costs nothing: the staff set is small and this is a rare admin write. Deleted rows are not
   * filtered out of the lock read; they are locked and then fail liveness.
   *
   * ⚠⚠ `FOR NO KEY UPDATE`, NOT `FOR UPDATE` (P1). Dozens of tables FK `users.id`, and Postgres's
   * RI trigger takes `FOR KEY SHARE` on the parent row for every child insert. `FOR UPDATE`
   * conflicts with `FOR KEY SHARE`, so holding it on every staff row would stall every audit
   * event, internal note or owner assignment naming ANY staff member for the life of a save — and
   * open a deadlock path with a transaction that key-shares two staff rows in the other order.
   * `FOR NO KEY UPDATE` conflicts with ITSELF, so two saves still serialise exactly as D6 and
   * ruling 2 require, and it is the same strength the following non-key `UPDATE` takes. The
   * ticket's "FOR UPDATE" wording meant serialisation, which is preserved. Precedent and full
   * argument: `reviews.concurrency.integration.test.ts`. Both halves are pinned by
   * `users.staff-access.concurrency.integration.test.ts`.
   *
   * ⚠ ORDERED BY ID SO SAVES CANNOT DEADLOCK. Postgres locks the rows of a `SELECT … ORDER BY …
   * FOR …` in sort order, so every saver acquires the rows it shares with another saver in the
   * same global order. Every other writer to these rows is a single-row `UPDATE`.
   *
   * ⚠ READ COMMITTED + EvalPlanQual — WHAT A BLOCKED SAVE SEES WHEN IT WAKES. The lock read's rows
   * come from its snapshot; a row a concurrent winner CHANGED is re-read at its committed version
   * and its predicate re-checked, so the loser evaluates the winner's committed state (that is what
   * makes the floor and the actor re-check race-safe). Two consequences, both in the SAFE
   * direction because both can only UNDER-count floor holders, never over-count them:
   *   · a row the winner moved OUT of the staff set (demoted to `user`) drops out of the scan —
   *     and a `user` row holds nothing anyway;
   *   · a row the winner moved INTO the staff set (a PROMOTION committed while this save waited)
   *     is NOT added, because it did not match in the snapshot. So a demotion racing the promotion
   *     of a new holder may be refused with `floor_violation` even though the promotion committed
   *     first. Refusing is safe, and a retry sees the new holder.
   *
   * ⚠ NOT COVERED HERE, deliberately (out of scope, pre-flight N5): soft-deleting the last floor
   * holder through some other path (no staff soft-delete path exists today), and a demoted person
   * staying named in `project_requests.balo_owner_user_id`.
   */
  saveStaffAccess: async (
    input: SaveStaffAccessInput,
    exec: DbExecutor = db
  ): Promise<SaveStaffAccessResult> => {
    const precheck = precheckStaffAccessSave(input);
    if (!precheck.ok) return { outcome: 'refused', reason: precheck.reason };

    return exec.transaction(async (tx): Promise<SaveStaffAccessResult> => {
      // ── 2. LOCK — before anything is read for evaluation. See the ⚠⚠ above on the strength.
      const rows = await tx
        .select(STAFF_ACCESS_ROW)
        .from(users)
        .where(
          or(
            inArray(users.id, [input.actorUserId, input.targetUserId]),
            inArray(users.platformRole, [...PLATFORM_STAFF_ROLES] as PlatformRole[])
          )
        )
        .orderBy(asc(users.id))
        .for('no key update');

      // ── 3. EVALUATE on the locked rows. A missing target is detected from `accounts`.
      const targetRow = rows.find((row) => row.id === input.targetUserId);
      const verdict = evaluateLockedStaffAccessSave(input, precheck, {
        accounts: rows.map(toStaffAccessPerson),
        targetIsDeleted: targetRow !== undefined && targetRow.deletedAt !== null,
      });
      if (!verdict.ok) return { outcome: 'refused', reason: verdict.reason };

      // ── 4. WRITE THE PAIR in one statement. `after.customList` is canonical and validated, so
      // the CHECK cannot fire here (N7).
      const { before, after } = verdict;
      const [updated] = await tx
        .update(users)
        .set({
          platformRole: after.role,
          platformCapabilities: after.customList === null ? null : [...after.customList],
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, input.targetUserId), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (updated === undefined) {
        // Unreachable while the row lock is held (the target was read live under it). Throwing
        // rolls the transaction back rather than auditing a change that did not happen.
        throw new Error('saveStaffAccess: target row vanished under lock');
      }

      // ── 5. AUDIT in the same transaction: role row first, then list row.
      const auditEventIds: string[] = [];
      if (verdict.roleChanged) {
        const row = await auditEventsRepository.record(
          {
            actorUserId: input.actorUserId,
            action: STAFF_ACCESS_AUDIT_ACTIONS.ROLE_CHANGED,
            entityType: 'user',
            entityId: input.targetUserId,
            metadata: { from: before.role, to: after.role },
          },
          tx
        );
        auditEventIds.push(row.id);
      }
      if (verdict.customListChanged) {
        const row = await auditEventsRepository.record(
          {
            actorUserId: input.actorUserId,
            action: STAFF_ACCESS_AUDIT_ACTIONS.CUSTOM_LIST_SET,
            entityType: 'user',
            entityId: input.targetUserId,
            metadata: { from: before.customList, to: after.customList },
          },
          tx
        );
        auditEventIds.push(row.id);
      }

      return {
        outcome: 'saved',
        roleChanged: verdict.roleChanged,
        customListChanged: verdict.customListChanged,
        auditEventIds,
      };
    });
  },

  /**
   * Create user without workspace (rare - use createWithWorkspace instead)
   */
  create: async (data: NewUser): Promise<User> => {
    const [user] = await db.insert(users).values(data).returning();
    return user!;
  },

  /**
   * Create user with personal workspace (standard signup flow).
   * This is a TRANSACTION - all or nothing.
   *
   * Used by:
   * - apps/web: OAuth callback (BAL-43)
   * - apps/api: Future invite acceptance webhooks
   */
  createWithWorkspace: async (
    data: NewUser
  ): Promise<{
    user: User;
    company: Company;
    membership: CompanyMember;
  }> => {
    return db.transaction(async (tx) => {
      // 1. Create user
      const [user] = await tx.insert(users).values(data).returning();
      if (user === undefined) throw new Error('users insert returned no row');

      // 2. Create personal workspace
      const workspaceName = data.firstName ? `${data.firstName}'s Workspace` : 'My Workspace';

      const [company] = await tx
        .insert(companies)
        .values({
          name: workspaceName,
          isPersonal: true,
        })
        .returning();
      if (company === undefined) throw new Error('companies insert returned no row');

      // 3. Add user as owner
      const [membership] = await tx
        .insert(companyMembers)
        .values({
          companyId: company.id,
          userId: user.id,
          role: 'owner',
          // BAL-345: self-documenting — this is the personal-workspace owner row
          // (the column also defaults to this value as a safety net).
          joinMethod: 'personal_workspace',
        })
        .returning();
      if (membership === undefined) throw new Error('company_members insert returned no row');

      // BAL-369 / ADR-1038: signup no longer claims a corporate domain. The domain
      // claim + org promotion now happen at the onboarding Intent step
      // (`companiesRepository.promoteToOrganization`), NOT here. A structural
      // invariant test (invariants/createwithworkspace-no-domain-claim.test.ts)
      // guards this seam against regression.
      return { user, company, membership };
    });
  },

  /**
   * Update user profile
   */
  update: async (id: string, data: Partial<NewUser>): Promise<User> => {
    const [user] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user!;
  },

  /**
   * Set the user's timezone ONLY. Executor-aware so it can ride the schedule
   * editor's transaction (BAL-234): the expert-side timezone change writes
   * `expert_profiles.timezone` (resolver SSOT) and this (`users.timezone`) in the
   * SAME tx, keeping them in lock-step.
   *
   * Deliberately does NOT touch `users.country`/`countryCode`: those are owned by
   * the explicit country picker (`saveCountryAction`), and an expert can author
   * working hours in a zone other than where they live (e.g. an AU expert serving
   * US clients in America/New_York). Inferring country from the zone here would
   * clobber the stated value on every schedule save — inference must not beat a
   * choice the user made by hand.
   */
  updateTimezone: async (
    userId: string,
    timezone: string,
    executor?: DbExecutor
  ): Promise<void> => {
    const exec = executor ?? db;
    // Guard on deletedAt IS NULL — this write is reachable from a request path
    // (the schedule save), so never resurrect a soft-deleted user's row.
    await exec
      .update(users)
      .set({ timezone, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  },

  /**
   * BAL-360: adopt a NEW workosId onto an existing LIVE user row (identity re-link),
   * writing an immutable audit row in the SAME transaction (ADR-1030). Guards on
   * deleted_at IS NULL — the caller resolved a live email match. Throws if the row
   * is missing (returning() empty).
   *
   * TWO account-takeover guards are ENFORCED here (fail closed, defense-in-depth) so
   * any future caller of this reusable seam cannot re-link an unverified identity:
   * - INCOMING profile (`opts.emailVerified !== true`) — checked before the tx opens.
   * - EXISTING row (BAL-362, `user.emailVerified !== true`) — checked inside the tx,
   *   after the update loads the current row, before the audit write. Reachable
   *   because the password path can persist an unverified users row (sign-in
   *   orphan-recovery). Throwing inside the tx rolls back the workosId write AND
   *   prevents the audit row.
   *
   * The caller still owns the user-facing conflict surface (e.g. AccountExistsError).
   */
  relinkWorkosId: async (
    userId: string,
    newWorkosId: string,
    opts: { actorUserId: string; oldWorkosId: string; email: string; emailVerified: boolean }
  ): Promise<User> => {
    // BAL-360 account-takeover guard (defense-in-depth): a re-link is only ever
    // safe on a WorkOS-verified email. The OAuth callback already checks this, but
    // enforce it here too so any future caller of this reusable seam cannot re-link
    // an unverified identity. Fail closed — never assume, never coerce.
    if (opts.emailVerified !== true) {
      throw new Error('relinkWorkosId: refusing to re-link an unverified identity');
    }
    return db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ workosId: newWorkosId, updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning();
      if (user === undefined) throw new Error('relinkWorkosId: user row not found');

      // BAL-362 existing-row account-takeover guard (fail-closed, defense-in-depth):
      // the row being re-linked ONTO must also be verified. The update only sets
      // workosId+updatedAt, so `user.emailVerified` here reflects the EXISTING row.
      // Throwing inside the tx rolls back the workosId write AND prevents the audit
      // row. Reachable because the password path can persist an unverified users row.
      if (user.emailVerified !== true) {
        throw new Error('relinkWorkosId: refusing to re-link onto an unverified existing row');
      }

      await auditEventsRepository.record(
        {
          actorUserId: opts.actorUserId,
          action: 'user.workos_relinked',
          entityType: 'user',
          entityId: userId,
          metadata: { oldWorkosId: opts.oldWorkosId, newWorkosId, email: opts.email },
        },
        tx
      );

      return user;
    });
  },

  /**
   * Mark phone as verified, writing phone + verified timestamp atomically.
   * Both fields are written together so the record never has a verified
   * timestamp pointing to a different phone number than what was verified.
   */
  setPhoneVerified: async (userId: string, phone: string, verifiedAt: Date): Promise<User> => {
    const [user] = await db
      .update(users)
      .set({ phone, phoneVerifiedAt: verifiedAt, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return user!;
  },

  /**
   * Update last active timestamp
   */
  touch: async (id: string): Promise<void> => {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, id));
  },

  /**
   * Batch NAME hydration (BAL-347) — projects id/firstName/lastName ONLY for a set
   * of user ids (never email/workosId/PII into a client-bound DTO). Excludes
   * soft-deleted users; returns `[]` for empty input (no query). Ordering is
   * unspecified — callers key by id. Batch-shaped for reuse (today: the join-mode
   * last-changed-by actor, a batch of one).
   */
  findNamesByIds: async (
    ids: string[]
  ): Promise<Array<{ id: string; firstName: string | null; lastName: string | null }>> => {
    if (ids.length === 0) return [];
    return db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(inArray(users.id, ids), isNull(users.deletedAt)));
  },

  /**
   * DISPLAY-ONLY hydration of ONE user (BAL-388) — `id` / `firstName` / `lastName` /
   * `avatarUrl`, and NOTHING else.
   *
   * ⚠⚠ THIS EXISTS SO A CLIENT-BOUND RENDER PATH CANNOT OVER-HYDRATE. `findById` returns the
   * whole `User`, including `email`, `workosId` and `phone`; a relational hydrate handed to a
   * counterparty-facing view is the exact shape of memory
   * `reference_drizzle_with_hydration_leaks_secrets`, and TypeScript will NOT catch it because
   * excess-property checking does not apply to spreads. Concealment here is enforced by what
   * the row CAN hold, not by remembering to omit downstream. Same posture as
   * {@link usersRepository.findNamesByIds}, for the single-row case that also needs an avatar.
   *
   * ⚠ `avatarUrl` MAY BE AN R2 KEY rather than a URL (Balo uploads store the key). Every
   * display site must run it through `getAvatarUrl()`.
   */
  findDisplayById: async (
    id: string
  ): Promise<
    | { id: string; firstName: string | null; lastName: string | null; avatarUrl: string | null }
    | undefined
  > => {
    const [row] = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-522 — `id` + `email` ONLY, for the ONE server-side path that legitimately needs an
   * actor's address: seeding a company's billing email from the first purchaser
   * (`ensureCustomer`).
   *
   * ⚠ NEVER `findById` HERE. That returns the whole `User` — `workosId`, `phone` and the
   * rest — and the value crosses into a Stripe Customer payload; the over-hydration shape of
   * memory `reference_drizzle_with_hydration_leaks_secrets`. Same projected posture as
   * {@link usersRepository.findNamesByIds} / {@link usersRepository.findDisplayById}; the
   * `{ id, email }` shape already exists on `findIncompleteOnboardingCreatedBetween`.
   *
   * Excludes soft-deleted users: a soft-deleted actor cannot be the live purchaser on a
   * money path, so `undefined` correctly SKIPS the seed (fail-soft, never a wrong address).
   */
  findEmailById: async (id: string): Promise<{ id: string; email: string } | undefined> => {
    const [row] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-374 onboarding-reminder sweep: non-deleted users who have NOT completed
   * onboarding and whose `created_at` falls in the HALF-OPEN window `(after, until]`
   * (`created_at > after AND created_at <= until`). Projects `id` + `email` ONLY
   * (email → domain-class recompute + engine recipient resolution; no PII beyond
   * that). The half-open lower bound is deliberate: the hourly sweep uses a
   * one-cron-period-wide band per cadence step, so a user whose `created_at` sits on
   * a tick boundary is matched on exactly ONE tick per step (no double-send). Ordering
   * is unspecified — the caller iterates per row.
   */
  findIncompleteOnboardingCreatedBetween: async (
    after: Date,
    until: Date
  ): Promise<Array<{ id: string; email: string }>> => {
    return db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.onboardingCompleted, false),
          isNull(users.deletedAt),
          gt(users.createdAt, after),
          lte(users.createdAt, until)
        )
      );
  },
};
