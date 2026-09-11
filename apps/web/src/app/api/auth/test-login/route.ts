import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { usersRepository } from '@balo/db';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { deriveWorkspacesForUser } from '@/lib/workspaces/derive-workspaces';
import { applyWorkspaceDerivationToSessionUser } from '@/lib/workspaces/session-workspace';
import { log } from '@/lib/logging';

export const dynamic = 'force-dynamic';

/**
 * E2E-only session seeding harness (WorkOS is bypassed). Mints an iron-session cookie for
 * one of two deterministic test personas — `'member'` or `'staff'` — in a chosen onboarding
 * state, so Playwright can exercise both the middleware onboarding gate and the platform-admin
 * shell without a real auth provider.
 *
 * SECURITY: this route is guarded by a deployment-agnostic, fail-safe SECRET gate that
 * is independent of `NODE_ENV` / `VERCEL` / platform:
 *   - `E2E_TEST_SECRET` absent (or empty) → 404, ALWAYS. Production never sets it, so the
 *     route is inert in production regardless of the runtime environment. Empty string is
 *     treated as unset so a mis-provisioned secret fails CLOSED.
 *   - `E2E_TEST_SECRET` set, but the request's `x-e2e-secret` header is missing or wrong →
 *     401 (compared in constant time; see `secretMatches`).
 *   - `E2E_TEST_SECRET` set and the header matches → proceed.
 * The gate is the first statement in the handler, so it can never mint a session unless
 * the caller presents the matching secret. The request carries the secret in the
 * `x-e2e-secret` request header — never the body.
 *
 * The request body cannot select an identity or an arbitrary role: it can only choose from a
 * CLOSED `persona` enum (`'member' | 'staff'`, see `TestPersona` below). Each persona maps to
 * exactly one derived email (on a fixed `@balo.test` domain that can never collide with a real
 * account) and exactly one platform role (`PERSONA_PLATFORM_ROLE`) — `super_admin` is
 * deliberately unreachable from this route. If the derived account resolves to a row whose
 * `platformRole` does not MATCH the persona's expected role, we refuse rather than mint —
 * before any mutation, in both directions (never elevate, never silently downgrade the staff
 * fixture into a member test).
 *
 * The secret is NEVER logged (the 404/401 branches return without logging).
 *
 * ⚠ THE STAFF ELEVATION WRITE IS OUTSIDE `createWithWorkspace`'s TRANSACTION (see
 * `resolveTestUser` below: the workspace insert commits, then a SEPARATE `usersRepository.update`
 * sets `platformRole: 'admin'`). A crash between those two writes leaves `staff-e2e@balo.test`
 * permanently at `'user'` — fail-CLOSED, so not a security defect (nobody gets elevated by
 * accident), but on a long-lived harness DB it wedges with no self-heal: every later `persona:
 * 'staff'` request 400s forever with an opaque `{error:'refused'}` (now logged, see F6) rather
 * than retrying the elevation. CI is unaffected (ephemeral Postgres per run); a shared seeded-E2E
 * environment is where this would bite — if a staff seed starts refusing there, inspect the row
 * before assuming the harness itself is broken.
 *
 * ⚠ THE STAFF ROW IS A WORKOS RE-LINK TARGET. It is minted with `emailVerified: true` AND
 * `platformRole: 'admin'`, and `resolveLinkedUser` (`@/lib/auth/resolve-identity.ts`) re-links an
 * incoming WorkOS identity onto a live email-matched row whenever BOTH sides are verified — after
 * which the OAuth callback mints THAT row's `platformRole`. Unreachable today: it needs a WorkOS
 * identity on a *verified* `@balo.test` address plus a database both the harness and a real auth
 * flow can reach, which is never true in CI or production. But it is a genuine widening of an
 * existing re-link seam, not a hypothetical — the reason the staff identity must stay on the
 * reserved `@balo.test` TLD forever, not get "helpfully" moved to a real domain later.
 */

/**
 * Constant-time secret comparison that never throws on a length mismatch.
 * timingSafeEqual requires equal-length buffers, so both sides are reduced to
 * fixed-length SHA-256 digests before comparison. Absent/empty input → false.
 */
function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * The two personas the harness can seed. A CLOSED enum: the body can select a persona, and a
 * persona maps to exactly one derived email and exactly one platform role. It can never name an
 * email, a role, or an arbitrary account.
 *
 * One const array, one derived type — `TEST_PERSONAS` is the single place the `'member' |
 * 'staff'` vocabulary is written on this side; `testLoginSchema`'s `z.enum` below is built from
 * this same array. `e2e/fixtures/auth.ts` keeps its OWN `SeedPersona` union rather than importing
 * this one — there is no root `tsconfig.json`, so `e2e/` is never typechecked against `apps/web`
 * and the two literal unions can never cross-check each other regardless. That copy is a
 * deliberate, unavoidable duplication, not drift — see the comment there.
 *
 * ⚠ `super_admin` IS DELIBERATELY UNREACHABLE FROM THIS ROUTE. Nothing in the admin lane needs
 * it — BAL-541's `DELETE_ANY_INTERNAL_NOTE` is the only super_admin-gated surface and it is out
 * of scope here — and a harness that can mint the platform's highest role is a different risk
 * class from one that can mint a support account. `PERSONA_PLATFORM_ROLE` below is the whole
 * space.
 */
const TEST_PERSONAS = ['member', 'staff'] as const;
type TestPersona = (typeof TEST_PERSONAS)[number];

/**
 * The platform role each persona is allowed to hold — and the ONLY roles this route can mint.
 * Exported (rather than sibling `./personas.ts`) so `route.test.ts` can enumerate the map itself
 * instead of re-deriving the expectation from the two personas it already knows exist — a test
 * that adds a third persona to `TEST_PERSONAS` + this map + the schema's `z.enum` without also
 * widening its own hard-coded expectations should fail, and only reading the map back does that.
 *
 * The value type is narrowed to `Extract<SessionUser['platformRole'], 'user' | 'admin'>` — NOT
 * the full `SessionUser['platformRole']` union — so widening any entry to `'super_admin'` fails
 * at COMPILE time (`TS2322: Type '"super_admin"' is not assignable to type '"admin" | "user"'`),
 * not only in the unit tests that happen to assert on it. This is what makes the "provably a
 * member of `{'user','admin'}` by TYPE" claim at the session-minting call site below actually
 * true, rather than an aspiration only two tests enforce.
 */
export const PERSONA_PLATFORM_ROLE: Readonly<
  Record<TestPersona, Extract<SessionUser['platformRole'], 'user' | 'admin'>>
> = {
  member: 'user',
  staff: 'admin',
};

/** The fixed staff identity. One address, on the same unreachable-by-a-real-user domain. */
const STAFF_EMAIL = 'staff-e2e@balo.test';

// Body cannot carry an email/firstName/role — only the onboarding state and a CLOSED persona.
// ⚠ `.strict()` IS LOAD-BEARING, NOT DECORATION. A bare `z.object()` STRIPS unknown keys, so
// `{ email, platformRole: 'super_admin' }` parses successfully today with the extra keys
// silently discarded. The property is safe either way (nothing reads them), but "a body
// carrying an email or a role field is REJECTED" is only true with this call. In-repo
// precedent: `(call)/meetings/[meetingId]/call/_actions/get-meeting-drawdown-state.ts:12`,
// `send-meeting-reaction.ts:23`.
const testLoginSchema = z
  .object({
    onboardingCompleted: z.boolean().default(false),
    persona: z.enum(TEST_PERSONAS).default('member'),
  })
  .strict();

/** Fixed test identities on a domain that can never belong to a real Balo user. */
function deriveTestEmail(persona: TestPersona, onboardingCompleted: boolean): string {
  if (persona === 'staff') return STAFF_EMAIL;
  return onboardingCompleted ? 'onboarded-e2e@balo.test' : 'unonboarded-e2e@balo.test';
}

type ResolveResult =
  | {
      ok: true;
      user: Awaited<ReturnType<typeof usersRepository.update>>;
      companyId: string;
      companyName: string;
      companyRole: 'owner' | 'admin' | 'member';
    }
  | { ok: false; reason: 'role_mismatch' };

/**
 * Upsert a deterministic test user keyed on a DERIVED email, reusing the standard
 * `createWithWorkspace` transaction so the user has a real personal-workspace
 * company/membership. Refuses (before any mutation) if the derived account's existing
 * `platformRole` does not MATCH the persona's expected role — belt-and-suspenders against
 * escalation, and against silently downgrading the staff fixture.
 */
async function resolveTestUser(
  persona: TestPersona,
  onboardingCompleted: boolean
): Promise<ResolveResult> {
  const email = deriveTestEmail(persona, onboardingCompleted);
  const expectedRole = PERSONA_PLATFORM_ROLE[persona];
  const existing = await usersRepository.findByEmail(email);

  if (existing) {
    // ⚠ THE GENERALISED REFUSAL. Previously "must be exactly 'user'"; now "must MATCH the
    // persona's role". Both directions matter: an arbitrary or pre-existing account can still
    // never be ELEVATED, and the staff fixture can never be silently DOWNGRADED into a member
    // test that then passes for the wrong reason. Refuse BEFORE any mutation.
    if (existing.platformRole !== expectedRole) {
      return { ok: false, reason: 'role_mismatch' };
    }
    const user = await usersRepository.update(existing.id, { onboardingCompleted });
    const withCompany = await usersRepository.findWithCompany(user.id);
    const membership = withCompany?.companyMemberships?.[0];
    if (!membership) {
      throw new Error('test-login: resolved user has no company membership');
    }
    return {
      ok: true,
      user,
      companyId: membership.company.id,
      companyName: membership.company.name,
      companyRole: membership.role,
    };
  }

  // ⚠ `createWithWorkspace` TAKES NO `platformRole` (preflight M8) — it mints a plain `user` row
  // inside the standard personal-workspace transaction. The staff persona therefore needs a
  // SECOND, EXPLICIT write. Widening `createWithWorkspace` was considered and rejected: it is
  // the production signup path and must not learn how to mint an elevated account.
  const created = await usersRepository.createWithWorkspace({
    workosId: `e2e_${crypto.randomUUID()}`,
    email,
    firstName: persona === 'staff' ? 'Staff' : 'E2E',
    lastName: 'Test',
    avatarUrl: null,
    emailVerified: true,
    activeMode: 'client',
    onboardingCompleted,
  });

  const user =
    expectedRole === 'user'
      ? created.user
      : await usersRepository.update(created.user.id, { platformRole: expectedRole });

  return {
    ok: true,
    user,
    companyId: created.company.id,
    companyName: created.company.name,
    companyRole: created.membership.role,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expectedSecret = process.env.E2E_TEST_SECRET;

  // Prod path: E2E_TEST_SECRET is NEVER set in production → always 404, regardless of
  // NODE_ENV / VERCEL / platform. Empty string is treated as unset (fail closed).
  if (!expectedSecret) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // Secret set but the request's header is missing or wrong → 401 (timing-safe).
  if (!secretMatches(request.headers.get('x-e2e-secret'), expectedSecret)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const body: unknown = await request.json();
    const parsed = testLoginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { onboardingCompleted, persona } = parsed.data;
    const resolved = await resolveTestUser(persona, onboardingCompleted);
    if (!resolved.ok) {
      // Derived account does not match the persona's expected role — never mint a session.
      // Logged (not silent): the persona seam adds a new way to reach this refusal (a
      // `staff-e2e@balo.test` row stuck at 'user' from a crashed elevation write, see the
      // docblock above), and an opaque `{error:'refused'}` gives the next person no thread
      // to pull without it.
      log.warn('E2E test-login refused', { persona, reason: resolved.reason });
      return NextResponse.json({ error: 'refused' }, { status: 400 });
    }

    const sessionUser: SessionUser = {
      id: resolved.user.id,
      email: resolved.user.email,
      firstName: resolved.user.firstName,
      lastName: resolved.user.lastName,
      avatarUrl: resolved.user.avatarUrl ?? null,
      activeMode: 'client',
      onboardingCompleted: resolved.user.onboardingCompleted,
      // ⚠ FROM THE CLOSED PERSONA MAP, NOT FROM THE ROW AND NOT FROM THE BODY. The refusal
      // above already proves the row agrees; reading the constant instead makes the minted
      // role provably a member of `{'user','admin'}` by TYPE, so no database state can widen it.
      platformRole: PERSONA_PLATFORM_ROLE[persona],
      companyId: resolved.companyId,
      companyName: resolved.companyName,
      companyRole: resolved.companyRole,
    };

    // ⚠⚠ BAL-494 / ADR-1053 — HYDRATE THE WORKSPACE POINTER BEFORE SEALING. NOT OPTIONAL, AND
    // NOT COSMETIC: without it this route mints a session shape NO REAL LOGIN PRODUCES, and the
    // harness is then testing a state the app never reaches.
    //
    // `checkSessionDrift` treats an ABSENT `activeWorkspace` as the pre-BAL-494 bootstrap case
    // and returns `sync-needed`, so a session sealed without it is DRIFTED THE INSTANT IT IS
    // WRITTEN. `(dashboard)/layout.tsx` then spends the very first navigation after seeding on a
    // `/api/auth/session-sync` round-trip — and that layout's `returnTo` reads
    // `headers().get('x-invoke-path')`, a header that DOES NOT EXIST IN NEXT 16, so it always
    // falls back to `/dashboard`. Net effect: `seedSession()` followed by `page.goto('/admin/…')`
    // landed on `/dashboard` no matter what role was sealed, which read exactly like a failing
    // capability gate (BAL-548 — three staff arms of `e2e/admin-shell.spec.ts`, CI-only because
    // no local harness ran the production `(dashboard)` layout). The cookie was always correct;
    // the session was merely incomplete.
    //
    // This is the SAME two-line hydration `api/auth/callback/route.ts` performs (see its
    // BAL-494 comment) and it goes through the ONE writer, `applyWorkspaceDerivationToSessionUser`
    // — never a hand-rolled `activeWorkspace` literal, which would fork the projection rule.
    // `derived === null` (no company membership at all) is unreachable here — `resolveTestUser`
    // throws above if the resolved user has no membership — but is handled rather than asserted,
    // exactly as the callback does.
    const derived = await deriveWorkspacesForUser(resolved.user.id);
    if (derived !== null) {
      applyWorkspaceDerivationToSessionUser(sessionUser, derived);
    }

    const session = await getSession();
    session.user = sessionUser;
    await session.save();

    return NextResponse.json({ ok: true, userId: sessionUser.id, onboardingCompleted, persona });
  } catch (error) {
    log.error('E2E test-login failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'test-login failed' }, { status: 500 });
  }
}
