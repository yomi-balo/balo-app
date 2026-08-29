import { describe, it, expect } from 'vitest';
import { sealData } from 'iron-session';
import type { Workspace } from '@balo/shared/workspaces';
import { COOKIE_NAME } from './session-config';
import type { SessionData, SessionUser } from './session';

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
 * representative payload below, that costs ~270 bytes per company workspace and crosses 4096
 * at FIVE of them (EIGHT on the leaner minimal session the auditor measured at 2326 bytes) —
 * a completely ordinary number of company memberships. Truncating or
 * capping the list is forbidden (R2: it would hide a workspace the user legitimately holds),
 * so the list was removed from the cookie entirely in security fix round 2. Only
 * `activeWorkspace` — one small object, the "what am I acting as" pointer that drift and every
 * consumer actually reads — is sealed. The list is derived server-side on every request
 * anyway (`checkSessionDrift` → `deriveWorkspacesForUser`, React-`cache()`d per request), and
 * `getWorkspacesForCurrentUser()` is its accessor.
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

const activeWorkspace: Workspace = {
  type: 'company',
  key: `company:${COMPANY_ID}`,
  companyId: COMPANY_ID,
  name: 'Northwind Industrial Holdings',
  via: 'membership',
  isPersonal: false,
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

/** A plausible company workspace with a real-world-length name. */
function companyWorkspace(index: number): Workspace {
  const companyId = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return {
    type: 'company',
    key: `company:${companyId}`,
    companyId,
    name: `Northwind Industrial Holdings ${index}`,
    via: 'membership',
    isPersonal: false,
  };
}

describe('balo_session cookie budget (BAL-494 R2)', () => {
  it('a fully-populated session with activeWorkspace seals well under the 4096-byte limit', async () => {
    const bytes = await sealedCookieBytes(sessionData);

    // Measured at ~2859 bytes on iron-session@8.0.4 at the time of writing. If this fails,
    // something was added to SessionData — do NOT raise the bound; work out what grew.
    expect(bytes).toBeLessThan(SAFE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(BROWSER_COOKIE_LIMIT_BYTES);
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
    const withFive = {
      ...sessionData,
      user: { ...user, workspaces: Array.from({ length: 5 }, (_, i) => companyWorkspace(i)) },
    };
    const withEight = {
      ...sessionData,
      user: { ...user, workspaces: Array.from({ length: 8 }, (_, i) => companyWorkspace(i)) },
    };

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
