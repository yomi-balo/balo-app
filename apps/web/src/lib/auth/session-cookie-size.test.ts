import { describe, it, expect, vi } from 'vitest';
import { sealData } from 'iron-session';
import type { ActiveWorkspacePointer, Workspace } from '@balo/shared/workspaces';
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '@balo/shared/authz';
import { COOKIE_NAME } from './session-config';
import type { SessionData, SessionUser } from './session';
import { sealedPlatformCapabilities } from './session-platform-capabilities';

// BAL-553 fix round 2, F6 — `sealPreservedAdminSession` reads `sessionConfig.password`, which
// `session-config.ts` reads from `process.env.WORKOS_COOKIE_PASSWORD` at MODULE LOAD time. Set
// before the hoisted imports below so the real seal path has a real (test) password, the same
// `vi.hoisted` + env-var technique `impersonation-guard-end-to-end.test.ts` uses.
vi.hoisted(() => {
  process.env.WORKOS_COOKIE_PASSWORD ??=
    'session-cookie-size-preserved-admin-test-password-0123456789';
});

import {
  sealPreservedAdminSession,
  PRESERVED_ADMIN_COOKIE,
} from './impersonation-preserved-session';

/**
 * BAL-494 orchestrator ruling R2 — THE COOKIE BUDGET GUARD.
 *
 * ⚠ WHAT THE 4096 IS. Every major browser caps a single cookie at **4096 bytes for the whole
 * `name=value` pair** (RFC 6265 §6.1 states 4096 as the minimum a UA must support; Chrome,
 * Firefox and Safari all enforce exactly that). Over it, the browser does not error — it
 * **silently discards the `Set-Cookie`**. For a session cookie that failure mode is a hard,
 * NON-SELF-HEALING LOCKOUT with no server-side signal: sign in → `session.save()` emits an
 * oversized `Set-Cookie` → the browser drops it → middleware sees no session → redirect to
 * `/login` → login re-runs the identical path, forever.
 *
 * ⚠ WHY THE WORKSPACE **LIST** IS NOT SEALED. The first cut of BAL-494 put the actor's full
 * `Workspace[]` in the cookie. Measured against this repo's `iron-session@8.0.4` with the
 * representative payload below, that costs ~290 bytes per (role-bearing) company workspace and
 * crosses 4096 at FIVE of them — a completely ordinary number of company memberships.
 * Truncating or capping the list is forbidden (R2: it would hide a workspace the user
 * legitimately holds), so the list was removed from the cookie entirely in security fix round
 * 2. Only `activeWorkspace` — now a narrow `ActiveWorkspacePointer` (BAL-507), the "what am I
 * acting as" pointer that drift and every consumer actually reads — is sealed. The list is
 * derived server-side on every request anyway (`checkSessionDrift` → `deriveWorkspacesForUser`,
 * React-`cache()`d per request), and `getWorkspacesForCurrentUser()` is its accessor.
 *
 * The second test below is the executable proof of that reasoning: it seals the SAME payload
 * WITH a list and shows it blowing the limit. If a future change puts a list-shaped field back
 * into `SessionData`, the first test fails long before a user does.
 */

/** iron-session requires ≥32 characters; length affects the seal's size only trivially. */
const PASSWORD = 'a-representative-32-plus-character-session-password-0123456789';

/**
 * The hard browser limit on `name=value`. Not a Balo choice — do not raise it.
 */
const BROWSER_COOKIE_LIMIT_BYTES = 4096;

/**
 * The bound this suite actually enforces, chosen to leave real headroom rather than sit on
 * the cliff edge: a session that measures 4090 today is one added field from a lockout.
 */
const SAFE_BUDGET_BYTES = 3500;

/**
 * A DELIBERATELY GENEROUS session: every optional field populated, a full-length WorkOS RS256
 * access token, a refresh token, an expert profile and a long real-world company name. A
 * typical session is smaller; the guard should hold for the worst ordinary case, not the best.
 */
const accessToken = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InNzb19vaWRjX2tleV9wYWlyXzAxSFhYWFhYWFhYWFhYWFhYWFhYWFhYWFgifQ.${'a'.repeat(620)}.${'b'.repeat(342)}`;
const refreshToken = 'r'.repeat(64);

const COMPANY_ID = '3a1f8e22-7b60-4a5d-8e19-2c4f6b8d0a11';

// BAL-507 (R-A) — the sealed cookie carries the narrow POINTER, never the full `Workspace`
// (see `ActiveWorkspacePointer`'s docblock). This is the real shape `applyWorkspaceDerivationTo
// SessionUser` writes.
const activeWorkspace: ActiveWorkspacePointer = {
  type: 'company',
  key: `company:${COMPANY_ID}`,
  companyId: COMPANY_ID,
  name: 'Northwind Industrial Holdings',
};

const user: SessionUser = {
  id: '9f2b7c1e-4d3a-4f88-9c21-0b7e6a5d4c33',
  email: 'dana.lovelace@northwind-industrial.example.com',
  firstName: 'Dana',
  lastName: 'Lovelace-Fitzgerald',
  avatarUrl: 'https://workoscdn.com/images/v1/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  activeMode: 'client',
  onboardingCompleted: true,
  platformRole: 'user',
  authMethod: 'oauth_google',
  companyId: COMPANY_ID,
  companyName: 'Northwind Industrial Holdings',
  companyRole: 'owner',
  expertProfileId: 'c4d5e6f7-1234-4a5b-9c8d-7e6f5a4b3c21',
  verticalId: 'ab12cd34-5678-4e9f-8a1b-2c3d4e5f6a70',
  activeWorkspace,
};

const sessionData: SessionData = { user, accessToken, refreshToken };

/** What the browser actually measures: the `name=value` pair, not the payload. */
async function sealedCookieBytes(data: unknown): Promise<number> {
  const sealed = await sealData(data, { password: PASSWORD });
  return `${COOKIE_NAME}=${sealed}`.length;
}

/**
 * A plausible company workspace with a real-world-length name — the shape a `workspaces[]`
 * LIST entry would carry (this is the hypothetical "proof of the reason" payload below, not
 * the pointer that is actually sealed). Post-BAL-507 a `via:'membership'` workspace requires
 * `role`, so this must supply one to remain a valid `Workspace`.
 */
function companyWorkspace(index: number): Workspace {
  const companyId = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return {
    type: 'company',
    key: `company:${companyId}`,
    companyId,
    name: `Northwind Industrial Holdings ${index}`,
    via: 'membership',
    isPersonal: false,
    role: 'owner',
  };
}

/**
 * BAL-560 — all 17 platform tokens: the largest override the axis can express (D10). Taken from
 * the one source of truth rather than retyped, so a token added to the axis grows this fixture
 * automatically and the budget is re-measured against the real worst case.
 */
const FULL_OVERRIDE: readonly PlatformCapability[] = Object.values(PLATFORM_CAPABILITIES);

describe('balo_session cookie budget (BAL-494 R2)', () => {
  it('a fully-populated session with activeWorkspace seals well under the 4096-byte limit', async () => {
    const bytes = await sealedCookieBytes(sessionData);

    // Measured at ~2817 bytes on iron-session@8.0.4 at the time of writing (BAL-507 re-measure:
    // was ~2859 before `activeWorkspace` narrowed to the `ActiveWorkspacePointer` shape). If
    // this fails, something was added to SessionData — do NOT raise the bound; work out what
    // grew.
    expect(bytes).toBeLessThan(SAFE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
  });

  // BAL-553 — the three impersonation fields (`isImpersonating`, `impersonatorUserId`,
  // `impersonationExpiresAt`) are small (a boolean, a uuid, an epoch-ms number), but they are
  // only ever ADDED on top of an otherwise fully-populated session — no `accessToken` /
  // `refreshToken` are dropped from the sealed payload (only from the LIVE `session.accessToken`
  // object, which this fixture cannot model), so this is the worst-case measurement.
  it('an impersonated session (with the three added fields) still seals well under budget', async () => {
    const impersonatedUser: SessionUser = {
      ...user,
      isImpersonating: true,
      impersonatorUserId: '11111111-1111-4111-8111-111111111111',
      impersonationExpiresAt: 1_700_000_000_000,
    };
    const bytes = await sealedCookieBytes({ ...sessionData, user: impersonatedUser });

    expect(bytes).toBeLessThan(SAFE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
  });

  // BAL-553 fix round 2, F6 — the ticket asked for a budget answer on BOTH cookies, and only
  // `balo_session` had one. `balo_admin_session` carries the SAME generous payload plus the
  // `purpose` discriminator (S2), and it rides every request DURING an impersonation ALONGSIDE
  // `balo_session` — two ~2.8KB cookies, not one. Real `sealPreservedAdminSession`, not a
  // hand-rolled `sealData` call, so a future change to what it seals is caught here too.
  it('the preserved-admin cookie (balo_admin_session) also seals well under the 4096-byte limit', async () => {
    const sealed = await sealPreservedAdminSession(sessionData);
    const bytes = `${PRESERVED_ADMIN_COOKIE}=${sealed}`.length;

    expect(bytes).toBeLessThan(SAFE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
  });

  /**
   * BAL-560 — THE TICKET'S FINAL AC: the actual sealed byte count for the worst REACHABLE case,
   * an ordinary staff session carrying the whole axis as a per-user override.
   */
  it('a staff session carrying the FULL 17-token override seals under budget (BAL-560)', async () => {
    // Non-vacuity: an empty or one-element override would seal tiny and prove nothing.
    expect(FULL_OVERRIDE).toHaveLength(17);

    const baseline = await sealedCookieBytes(sessionData);
    const bytes = await sealedCookieBytes({
      ...sessionData,
      user: { ...user, platformRole: 'admin', platformCapabilities: [...FULL_OVERRIDE] },
    });

    // Measured 3393 bytes on iron-session@8.0.4 (baseline 2817). 107 bytes under the safe
    // budget, 703 under the browser cliff. If this fails, do NOT raise the bound — work out
    // what grew. The field NAME is part of the budget: `platformCapabilities` measures 3393;
    // any name of 12 characters or fewer measures 3371 (AES block quantisation, not linear in
    // name length). The long name was chosen deliberately (D4 / OBJ-4) — it matches the DB
    // column, the repository projection and the api actor property, so no hand-off carries a
    // rename, and a rename at a hand-off is exactly where the "one seal point forgot" bug hides.
    expect(bytes).toBeLessThan(SAFE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
    // Non-vacuity: prove the override was actually SEALED, not silently dropped by the fixture.
    expect(bytes - baseline).toBeGreaterThan(500);
  });

  /**
   * BAL-560 — PROOF OF THE REASON FOR D1'S CHECK, at the cookie layer. This combination measures
   * 3542 bytes — OVER the safe budget — and is unreachable ONLY because BOTH locks hold: an
   * impersonation target cannot be staff (`lib/auth/actions/impersonation.ts`'s
   * `platformRoleIsStaff` refusal) AND a non-staff row cannot carry an override (the
   * `users_platform_capabilities_staff_array` table CHECK). If either is ever relaxed, the
   * cookie budget is the thing that breaks — silently, as a non-self-healing lockout. This test
   * is why D1 is a CHECK and not a convention.
   */
  it('PROOF OF THE REASON (D1): an IMPERSONATED session carrying the same override would BLOW the budget', async () => {
    const bytes = await sealedCookieBytes({
      ...sessionData,
      user: {
        ...user,
        platformRole: 'admin',
        platformCapabilities: [...FULL_OVERRIDE],
        isImpersonating: true,
        impersonatorUserId: '11111111-1111-4111-8111-111111111111',
        impersonationExpiresAt: 1_700_000_000_000,
      },
    });

    expect(bytes).toBeGreaterThan(SAFE_BUDGET_BYTES);
    // Still under the hard cliff — a budget breach, not yet a lockout. The margin is the point.
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
  });

  /**
   * ⚠⚠ FIX ROUND 1, SECURITY F1 — **PROOF OF THE REASON FOR THE SEAL-PATH NORMALISATION.**
   *
   * Before the fix, `sealedPlatformCapabilities` sealed the column's RAW value. The axis has only
   * 17 distinct tokens, so the array looked bounded — but nothing stopped a row from carrying the
   * SAME token any number of times, and every entry is a valid token, so neither the shape CHECK
   * nor the read-path filter would have caught it. This test seals the raw duplicate array to
   * show the cliff being crossed, then seals the SAME array through the real encoder to show it
   * collapsing to one entry.
   *
   * Measured with the LONGEST token on the axis (`manage_any_engagement_action_item`, 33 chars),
   * which is the honest worst case: 17 copies = 3670, 24 = 3990, **26 = 4097 — past the
   * 4096-byte browser cliff**, 30 = 4289, 40 = 4758. Past that line the browser silently
   * discards the `Set-Cookie` and the user is locked out with no server-side error.
   */
  it('PROOF OF THE REASON (F1): a DUPLICATE-heavy override blows the cliff RAW, and is bounded by the encoder', async () => {
    const longestToken = [...FULL_OVERRIDE].sort((a, b) => b.length - a.length)[0];
    expect(longestToken, 'the axis must be non-empty').toBeDefined();
    if (longestToken === undefined) return;
    expect(longestToken).toBe('manage_any_engagement_action_item');

    const twentySixCopies = Array.from({ length: 26 }, () => longestToken);
    expect(twentySixCopies).toHaveLength(26);

    // (a) RAW — what the seal path used to do. Over the HARD browser limit: a silent lockout.
    const rawBytes = await sealedCookieBytes({
      ...sessionData,
      user: { ...user, platformRole: 'admin', platformCapabilities: twentySixCopies },
    });
    expect(rawBytes).toBeGreaterThan(BROWSER_COOKIE_LIMIT_BYTES);

    // (b) THROUGH THE REAL ENCODER — de-duplicated to a single entry, far under budget.
    const encodedBytes = await sealedCookieBytes({
      ...sessionData,
      user: {
        ...user,
        platformRole: 'admin',
        ...sealedPlatformCapabilities({ platformCapabilities: twentySixCopies }),
      },
    });
    expect(encodedBytes).toBeLessThan(SAFE_BUDGET_BYTES);
    // Non-vacuity: the encoder really did collapse it, rather than dropping the field entirely.
    expect(
      sealedPlatformCapabilities({ platformCapabilities: twentySixCopies }).platformCapabilities
    ).toEqual([longestToken]);
  });

  /**
   * AT THE BOUND. After the fix the sealed value is always a DE-DUPLICATED subset of the axis, so
   * the largest cookie any override can produce is the full 17 DISTINCT tokens — which is exactly
   * the 3393-byte case pinned above. This test states that as a property rather than leaving it
   * implicit: seal the whole axis twice over and the result is byte-identical to sealing it once.
   */
  it('AT THE BOUND: the whole axis twice over seals identically to the axis once (17 distinct IS the maximum)', async () => {
    const axisOnce = { platformCapabilities: [...FULL_OVERRIDE] };
    const axisTwice = { platformCapabilities: [...FULL_OVERRIDE, ...FULL_OVERRIDE] };
    expect(axisTwice.platformCapabilities).toHaveLength(34);

    const onceBytes = await sealedCookieBytes({
      ...sessionData,
      user: { ...user, platformRole: 'admin', ...sealedPlatformCapabilities(axisOnce) },
    });
    const twiceBytes = await sealedCookieBytes({
      ...sessionData,
      user: { ...user, platformRole: 'admin', ...sealedPlatformCapabilities(axisTwice) },
    });

    expect(twiceBytes).toBe(onceBytes);
    expect(twiceBytes).toBeLessThan(SAFE_BUDGET_BYTES);
  });

  /**
   * FIX ROUND 1, SECURITY F6 — the PRESERVED-ADMIN cookie carries the same payload and rides
   * every request DURING an impersonation, alongside `balo_session`. The existing test below
   * measures it with no override; this measures the worst case a real staff member can produce.
   *
   * Measured **3463 bytes** — only **37** under the safe budget, against `balo_session`'s 107 for
   * the same override. It is the TIGHTER of the two cookies, which is exactly why it needs its
   * own measurement rather than an inference from the session cookie's headroom.
   */
  it('the preserved-admin cookie with a super_admin + FULL 17-token override is still under budget (F6)', async () => {
    expect(FULL_OVERRIDE).toHaveLength(17);

    const sealed = await sealPreservedAdminSession({
      ...sessionData,
      user: { ...user, platformRole: 'super_admin', platformCapabilities: [...FULL_OVERRIDE] },
    });
    const bytes = `${PRESERVED_ADMIN_COOKIE}=${sealed}`.length;

    expect(bytes).toBeLessThan(SAFE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
    // Non-vacuity: prove the override was actually sealed into THIS cookie too.
    const baseline = `${PRESERVED_ADMIN_COOKIE}=${await sealPreservedAdminSession(sessionData)}`
      .length;
    expect(bytes - baseline).toBeGreaterThan(500);
  });

  it('the SessionUser type carries no workspace LIST field — compile-time pin', () => {
    // Reintroducing `workspaces` to `SessionUser` resolves `NoWorkspaceListOnSessionUser` to
    // `never`, `true` stops being assignable to it, and `pnpm typecheck` fails — the
    // regression is caught at build time, not by a locked-out user. A conditional type rather
    // than `@ts-expect-error` on an excess property, because that would depend on TypeScript's
    // excess-property-check behaviour through an object spread; this does not.
    //
    // Paired with, not a substitute for, the byte assertions: a type pin alone would not
    // catch a DIFFERENT unbounded field being added.
    type NoWorkspaceListOnSessionUser = 'workspaces' extends keyof SessionUser ? never : true;
    const pin: NoWorkspaceListOnSessionUser = true;
    expect(pin).toBe(true);
  });

  it('PROOF OF THE REASON: sealing the workspace LIST blows the limit at ordinary scale', async () => {
    // Five company memberships is unremarkable for an agency admin or a consultant who has
    // been invited into several client orgs. This is the lockout that fix round 2 removed.
    //
    // BAL-507 fix round — the prose claims the budget crosses 4096 AT five, but until now only
    // the ">4096 at five" side was pinned; nothing asserted the "<4096 at four" side, so the
    // word "AT" was only half-backed by an assertion. `withFour` closes that gap (measured:
    // 3990 bytes).
    const withFour = {
      ...sessionData,
      user: { ...user, workspaces: Array.from({ length: 4 }, (_, i) => companyWorkspace(i)) },
    };
    const withFive = {
      ...sessionData,
      user: { ...user, workspaces: Array.from({ length: 5 }, (_, i) => companyWorkspace(i)) },
    };
    const withEight = {
      ...sessionData,
      user: { ...user, workspaces: Array.from({ length: 8 }, (_, i) => companyWorkspace(i)) },
    };

    expect(await sealedCookieBytes(withFour)).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
    expect(await sealedCookieBytes(withFive)).toBeGreaterThan(BROWSER_COOKIE_LIMIT_BYTES);
    expect(await sealedCookieBytes(withEight)).toBeGreaterThan(BROWSER_COOKIE_LIMIT_BYTES);
  });

  it('growth is roughly linear in list length, so no cap would be safe for long', async () => {
    // Documents the shape of the failure rather than a single data point: each additional
    // company workspace costs a couple of hundred sealed bytes, so any cap chosen today is
    // one product decision away from being wrong. Deriving per request has no such ceiling.
    const baseline = await sealedCookieBytes(sessionData);
    const withTwenty = await sealedCookieBytes({
      ...sessionData,
      user: { ...user, workspaces: Array.from({ length: 20 }, (_, i) => companyWorkspace(i)) },
    });

    expect(withTwenty - baseline).toBeGreaterThan(BROWSER_COOKIE_LIMIT_BYTES);
  });
});
