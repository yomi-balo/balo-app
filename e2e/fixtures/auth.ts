import { test as base, expect } from '@playwright/test';

/**
 * E2E auth fixture. Seeds an iron-session cookie for a deterministic test user in a
 * chosen onboarding state (and, optionally, persona) by POSTing to the secret-gated
 * `/api/auth/test-login` route (WorkOS is bypassed). The route is guarded by a server-side
 * secret: it is inert (404) whenever `E2E_TEST_SECRET` is unset (production), independent of
 * `NODE_ENV`/platform. This fixture authenticates by sending the matching secret in the
 * `x-e2e-secret` header, so it only succeeds against a server that has `E2E_TEST_SECRET` set
 * (the seeded-E2E harness: ephemeral Postgres + `WORKOS_COOKIE_PASSWORD` + `E2E_TEST_SECRET`).
 */

/**
 * The closed persona vocabulary the route accepts. Never an email, never a role.
 *
 * A DELIBERATE COPY of `TestPersona` in `apps/web/src/app/api/auth/test-login/route.ts` — not
 * shared, and not drift. There is no root `tsconfig.json`; `e2e/` is not typechecked against
 * `apps/web` at all, so an import across that boundary would not buy any actual cross-checking,
 * and the two literal unions must be kept in sync by hand if the route's vocabulary ever changes.
 */
type SeedPersona = 'member' | 'staff';

type SeedOptions = { onboardingCompleted: boolean; persona?: SeedPersona };

type AuthFixtures = {
  /** Seed the browser context with a session in the given onboarding state (and persona). */
  seedSession: (opts: SeedOptions) => Promise<void>;
};

export const test = base.extend<AuthFixtures>({
  seedSession: async ({ page }, use) => {
    await use(async ({ onboardingCompleted, persona }: SeedOptions) => {
      const response = await page.request.post('/api/auth/test-login', {
        headers: { 'x-e2e-secret': process.env.E2E_TEST_SECRET ?? '' },
        // Omit the key entirely when unset — the schema is `.strict()`, and an explicit
        // `persona: undefined` is a key JSON.stringify drops anyway. Be explicit rather than
        // lucky.
        data: persona === undefined ? { onboardingCompleted } : { onboardingCompleted, persona },
      });
      if (!response.ok()) {
        throw new Error(
          `test-login seeding failed (${response.status()}) — is the seeded-E2E harness up ` +
            `(E2E_TEST_SECRET set on the server + matching header, plus a reachable Postgres)?`
        );
      }
    });
  },
});

export { expect };
