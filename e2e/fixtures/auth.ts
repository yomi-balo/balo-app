import { test as base, expect, type Page } from '@playwright/test';

/**
 * E2E auth + booking-context seeding fixture. Seeds real data via the secret-gated
 * `/api/auth/test-login` and `/api/e2e/seed` routes (WorkOS + a real slot-availability
 * pipeline are both bypassed at the DATA level — see `apps/web/src/app/api/e2e/seed/route.ts`'s
 * docblock for exactly what each seed shortcuts and why). Both routes are guarded by the SAME
 * server-side secret (`@/lib/e2e/require-e2e-secret`): inert (404) whenever `E2E_TEST_SECRET`
 * is unset (production), independent of `NODE_ENV`/platform. This fixture only succeeds against
 * a server that has `E2E_TEST_SECRET` set (the seeded-E2E harness: ephemeral Postgres +
 * `WORKOS_COOKIE_PASSWORD` + `E2E_TEST_SECRET`).
 */
type SeedOptions = { onboardingCompleted: boolean };

interface SeedExpertResult {
  expertProfileId: string;
  username: string;
}

interface SeedCompanyResult {
  companyId: string;
  companyName: string;
}

interface SeedCaseResult {
  engagementId: string;
  title: string;
}

type AuthFixtures = {
  /** Seed the browser context with a session in the given onboarding state. */
  seedSession: (opts: SeedOptions) => Promise<void>;
  /** Seed a fresh, fully approved, publicly bookable expert with wide-open weekly hours. */
  seedExpert: () => Promise<SeedExpertResult>;
  /** Add a SECOND company membership for the current session user (multi-company picker). */
  seedSecondCompany: () => Promise<SeedCompanyResult>;
  /**
   * Create a real open case for the current session user's primary company + a named expert.
   * Pass `bookingNonce` to stamp a `bookingIdempotencyKey` derived the SAME way the real
   * booking action derives it — pair with `forceBookingNonce` to drive a genuine idempotent
   * case-grain replay through the real UI (see `case-booking.spec.ts`'s path (d)).
   */
  seedOpenCase: (input: {
    expertProfileId: string;
    title: string;
    bookingNonce?: string;
  }) => Promise<SeedCaseResult>;
  /**
   * Force the browser's `crypto.randomUUID()` to always return `nonce`, so the booking
   * dialog's client-minted nonce (`booking-flow-dialog.tsx`'s `randomNonce()`) is
   * predictable and can be pre-matched by a seeded `bookingIdempotencyKey`. Must be called
   * BEFORE `page.goto(...)` (it installs an init script for future navigations).
   */
  forceBookingNonce: (nonce: string) => Promise<void>;
};

async function seedRequest(page: Page, body: unknown): Promise<Record<string, unknown>> {
  const response = await page.request.post('/api/e2e/seed', {
    headers: { 'x-e2e-secret': process.env.E2E_TEST_SECRET ?? '' },
    data: body,
  });
  if (!response.ok()) {
    // Surface the server's REASON, not just the status. The route returns it deliberately
    // (it is secret-gated), and without it a 500 here is undiagnosable from the CI log —
    // Playwright's `[WebServer]` capture does not include the route's own logging.
    const detail = await response.text().catch(() => '');
    throw new Error(
      `/api/e2e/seed seeding failed (${response.status()}) — is the seeded-E2E harness up ` +
        `(E2E_TEST_SECRET set on the server + matching header, a reachable Postgres, and ` +
        `reference data seeded)?${detail ? ` Server said: ${detail}` : ''}`
    );
  }
  return response.json() as Promise<Record<string, unknown>>;
}

export const test = base.extend<AuthFixtures>({
  seedSession: async ({ page }, use) => {
    await use(async ({ onboardingCompleted }: SeedOptions) => {
      const response = await page.request.post('/api/auth/test-login', {
        headers: { 'x-e2e-secret': process.env.E2E_TEST_SECRET ?? '' },
        data: { onboardingCompleted },
      });
      if (!response.ok()) {
        throw new Error(
          `test-login seeding failed (${response.status()}) — is the seeded-E2E harness up ` +
            `(E2E_TEST_SECRET set on the server + matching header, plus a reachable Postgres)?`
        );
      }
    });
  },

  seedExpert: async ({ page }, use) => {
    await use(async () => {
      const result = await seedRequest(page, { kind: 'expert' });
      return result as unknown as SeedExpertResult;
    });
  },

  seedSecondCompany: async ({ page }, use) => {
    await use(async () => {
      const result = await seedRequest(page, { kind: 'company' });
      return result as unknown as SeedCompanyResult;
    });
  },

  seedOpenCase: async ({ page }, use) => {
    await use(async (input) => {
      const result = await seedRequest(page, { kind: 'case', ...input });
      return result as unknown as SeedCaseResult;
    });
  },

  forceBookingNonce: async ({ page }, use) => {
    await use(async (nonce: string) => {
      await page.addInitScript((fixedNonce: string) => {
        Object.defineProperty(window.crypto, 'randomUUID', {
          configurable: true,
          value: () => fixedNonce as ReturnType<Crypto['randomUUID']>,
        });
      }, nonce);
    });
  },
});

export { expect };
