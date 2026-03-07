---
name: testing
description: Testing patterns and decision framework for the Balo marketplace platform. Use when writing tests alongside feature code, adding tests to existing modules, or reviewing test coverage. Covers Vitest unit tests, React Testing Library component tests, Fastify API integration tests, Drizzle DB tests, Playwright E2E flows, and accessibility checks. Guides what to test vs skip for each task category. Includes mocking patterns for WorkOS, Stripe Connect, Supabase Realtime, and other external services.
---

# Testing — Balo Platform

## Philosophy

Test what breaks expensively. Skip what breaks cheaply. Balo is a marketplace handling auth, payments, and real-time communication — bugs in these systems lose money or trust. Tests exist to catch those bugs, not to hit coverage numbers.

**Write tests alongside code, not after.** Every PR that touches business logic, auth, payments, or data access should include tests. Every PR that's pure layout/styling should not.

## Monorepo Test Architecture

```
balo-app/
├── apps/web/                     # Vitest (jsdom) + Testing Library
│   ├── src/test/setup.ts         # Global setup, RTL cleanup, mocks
│   ├── src/test/utils.tsx        # Custom render with providers
│   └── src/**/*.test.{ts,tsx}    # Colocated with source files
├── apps/api/                     # Vitest (node) + Fastify inject
│   └── src/**/*.test.ts          # Colocated with source files
├── packages/db/                  # Vitest (node) + test database
│   └── src/**/*.test.ts          # Repository integration tests
├── e2e/                          # Playwright (3 browsers + mobile)
│   ├── *.spec.ts                 # Golden path user journeys
│   └── fixtures/                 # Auth state, seed data
└── vitest.config.ts              # Workspace: projects [web, api]
```

### Vitest Workspace Config

The workspace is defined in `vitest.config.ts` at the monorepo root. Each app is registered as a `project`. **When adding a new package that needs tests, add it to the `projects` array** — otherwise Vitest won't discover its test files:

```typescript
// vitest.config.ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/web/vitest.config.ts', // jsdom env, React Testing Library
  'apps/api/vitest.config.ts', // node env, Fastify inject
  'packages/db/vitest.config.ts', // node env, test DB
  // Add new packages here
]);
```

Each per-package config sets the correct environment (`jsdom` vs `node`) and any package-specific globals or setup files.

### Running Tests

```bash
pnpm test              # Vitest watch mode (all workspaces)
pnpm test:run          # Vitest single run (CI)
pnpm test:coverage     # Vitest with V8 coverage
pnpm test:e2e          # Playwright (all browsers)
pnpm test:e2e:ui       # Playwright interactive UI
```

## Decision Framework: What to Test

### ALWAYS test (high value, catches expensive bugs)

| Category                       | Test type   | Example                                                 |
| ------------------------------ | ----------- | ------------------------------------------------------- |
| Zod schemas & validation       | Unit        | signUpSchema, caseBookingSchema, priceCalculation       |
| Price/fee calculations         | Unit        | Platform fee splits, Stripe amount conversions          |
| Permission/authorization logic | Unit        | canUserBookExpert(), isCompanyAdmin()                   |
| Data access repositories       | Integration | UserRepository.findByEmail(), ExpertRepository.search() |
| Server Actions (mutations)     | Integration | createCase(), submitBooking(), updateProfile()          |
| Fastify API routes             | Integration | POST /webhooks/stripe, POST /webhooks/workos            |
| Auth flows                     | E2E         | Sign up → onboard → search → book (golden path)         |
| Payment flows                  | E2E         | Checkout → payment → confirmation                       |

### SELECTIVELY test (medium value, test if complex)

| Category               | Test type | When to test                                             |
| ---------------------- | --------- | -------------------------------------------------------- |
| Interactive components | Component | Multi-state (auth modal, search filters, booking wizard) |
| Form components        | Component | Complex validation, conditional fields, async submission |
| Custom hooks           | Unit      | useDebounce, useInfiniteScroll, useAuthModal             |
| Utility functions      | Unit      | formatCurrency, slugify, dateHelpers                     |

### NEVER test (low value, high maintenance)

- Static/presentational components (cards, badges, layout wrappers)
- shadcn/ui primitives or enhanced/ wrappers (tested upstream)
- CSS/Tailwind styling (visual regression is a different tool)
- Next.js config files
- Type definitions
- Simple re-exports

## Unit Tests (Vitest)

### When: Pure functions, schemas, calculations, permission checks

File convention: `*.test.ts` colocated next to source file.

```typescript
// src/lib/pricing.test.ts
import { describe, it, expect } from 'vitest';
import { calculatePlatformFee, calculateExpertPayout } from './pricing';

describe('calculatePlatformFee', () => {
  it('applies 20% fee on case consultations', () => {
    expect(calculatePlatformFee({ type: 'case', amount: 10000 })).toBe(2000);
  });

  it('applies 15% fee on package purchases', () => {
    expect(calculatePlatformFee({ type: 'package', amount: 50000 })).toBe(7500);
  });

  it('rounds to nearest cent', () => {
    expect(calculatePlatformFee({ type: 'case', amount: 333 })).toBe(67); // not 66.6
  });

  it('rejects negative amounts', () => {
    expect(() => calculatePlatformFee({ type: 'case', amount: -100 })).toThrow();
  });
});
```

### Zod Schema Tests

Always test schemas that guard user input or API boundaries:

```typescript
// src/lib/schemas/auth.test.ts
import { describe, it, expect } from 'vitest';
import { signUpSchema } from './auth';

describe('signUpSchema', () => {
  const validData = {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    password: 'SecurePass1',
  };

  it('accepts valid input', () => {
    expect(signUpSchema.safeParse(validData).success).toBe(true);
  });

  it('rejects password without uppercase', () => {
    const result = signUpSchema.safeParse({ ...validData, password: 'nouppercas1' });
    expect(result.success).toBe(false);
  });

  it('rejects password under 8 chars', () => {
    const result = signUpSchema.safeParse({ ...validData, password: 'Short1' });
    expect(result.success).toBe(false);
  });

  // Test every rule independently — these catch drift between
  // schema validation and UI strength indicators (see BAL-168)
});
```

## Component Tests (Vitest + Testing Library)

### When: Interactive components with state, user events, conditional rendering

File convention: `*.test.tsx` colocated next to component.

**Use the custom render from `src/test/utils.tsx`** — it wraps with providers (auth context, query client, theme). Update this wrapper as new providers are added.

```typescript
// src/components/balo/auth/auth-modal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { AuthModal } from './auth-modal';

describe('AuthModal', () => {
  it('switches between login and signup views', async () => {
    const user = userEvent.setup();
    render(<AuthModal defaultView="login" open onOpenChange={vi.fn()} />);

    expect(screen.getByText(/sign in/i)).toBeInTheDocument();

    await user.click(screen.getByText(/create an account/i));
    expect(screen.getByText(/sign up/i)).toBeInTheDocument();
  });

  it('shows validation errors on invalid submit', async () => {
    const user = userEvent.setup();
    render(<AuthModal defaultView="signup" open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/email is required/i)).toBeInTheDocument();
  });

  it('disables submit button during loading', async () => {
    // ...test loading states per provider
  });
});
```

### Testing Library Best Practices

- **Query by role first**: `getByRole('button', { name: /submit/i })` — mirrors how users interact
- **Use `userEvent` not `fireEvent`**: `userEvent.setup()` then `user.click()` — fires real event sequences
- **Avoid `getByTestId`**: Only use when no accessible selector exists. If you need testId, the component may have an a11y gap.
- **Assert from user perspective**: "text is visible" not "state variable equals X"
- **Don't test implementation**: Never assert on state, hooks, or internal methods

### Accessibility Testing (axe-core)

Add a11y assertions to component tests for any user-facing interactive component:

```typescript
// Add to apps/web/src/test/setup.ts (once, globally) — NOT per-test file
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

// Then in any component test — no import needed:
it('has no accessibility violations', async () => {
  const { container } = render(<AuthModal defaultView="login" open onOpenChange={vi.fn()} />);
  expect(await axe(container)).toHaveNoViolations();
});
```

Install: `pnpm --filter web add -D jest-axe @types/jest-axe`

**Note:** `jest-axe` uses Vitest's `expect` — the `toHaveNoViolations` matcher works with Vitest's `expect.extend`. Do not call `expect.extend(toHaveNoViolations)` per-test file; it will get repetitive and is likely to be skipped.

## API Integration Tests (Vitest + Fastify inject)

### When: API routes, webhook handlers, middleware

Fastify's `.inject()` method sends fake HTTP requests without starting a server. This is already established in the codebase (see `apps/api/src/routes/health.test.ts`).

```typescript
// apps/api/src/routes/webhooks/stripe.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';

// Mock Stripe webhook signature verification
vi.mock('stripe', () => ({
  default: class {
    webhooks = {
      constructEvent: vi.fn().mockImplementation((body, sig, secret) => {
        if (sig === 'invalid') throw new Error('Invalid signature');
        return JSON.parse(body);
      }),
    };
  },
}));

describe('POST /webhooks/stripe', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 400 on invalid signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'invalid' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(400);
  });

  it('processes checkout.session.completed', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_123', metadata: { caseId: 'case_1' } } },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'valid_sig' },
      payload: JSON.stringify(event),
    });

    expect(response.statusCode).toBe(200);
    // Assert side effects: case status updated, notification sent, etc.
  });
});
```

## Server Action Tests (Vitest + Fastify inject)

Server Actions are async functions, not HTTP handlers — they cannot be tested with Fastify inject. Test them by calling the function directly after mocking external services.

```typescript
// apps/web/src/app/actions/booking.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCaseBooking } from './booking';
import { mockWorkOS } from '@/test/mocks/workos';
import { mockStripe } from '@/test/mocks/stripe';
import { testDb } from '@balo/db/test';

// Server Actions rely on Next.js cookies/headers — mock them
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue({ value: 'mock_session_token' }),
  }),
  headers: vi.fn().mockReturnValue(new Headers()),
}));

describe('createCaseBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a Stripe checkout session for a valid booking', async () => {
    const result = await createCaseBooking({
      expertId: 'expert_test_1',
      durationMinutes: 30,
    });

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        metadata: expect.objectContaining({ expertId: 'expert_test_1' }),
      })
    );
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/pay/cs_test_123');
  });

  it('returns an error when user has insufficient credits', async () => {
    // Override balance for this test
    vi.spyOn(testDb, 'select').mockResolvedValueOnce([{ balanceCents: 0 }]);

    const result = await createCaseBooking({
      expertId: 'expert_test_1',
      durationMinutes: 30,
    });

    expect(result.error).toMatch(/insufficient/i);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
```

**Key difference from API route tests:** Server Actions run in the Next.js runtime and can access cookies, headers, and auth context via `next/headers`. Always mock `next/headers` in Server Action tests.

## Database Integration Tests (Vitest + Drizzle)

### When: Repository methods, complex queries, transaction logic

Use a dedicated test database. Never mock the database layer for integration tests — the whole point is testing real SQL.

### Test Database Setup

```typescript
// packages/db/src/test/setup.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../schema';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/balo_test';

// Connection for migrations (must not be in pool mode)
const migrationClient = postgres(TEST_DATABASE_URL, { max: 1 });

// Connection for tests
const queryClient = postgres(TEST_DATABASE_URL);
export const testDb = drizzle(queryClient, { schema });

export async function setupTestDatabase() {
  await migrate(drizzle(migrationClient, { schema }), {
    migrationsFolder: './drizzle',
  });
}

export async function teardownTestDatabase() {
  await migrationClient.end();
  await queryClient.end();
}

export async function cleanTables() {
  // Truncate in correct order (respect FK constraints)
  await testDb.execute(sql`
    TRUNCATE TABLE case_messages, case_participants, cases,
    expert_availabilities, expert_profiles, company_members, companies,
    users CASCADE
  `);
}
```

### Repository Test Pattern

```typescript
// packages/db/src/repositories/user.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testDb, setupTestDatabase, teardownTestDatabase, cleanTables } from '../test/setup';
import { createUserRepository } from './user';

const userRepo = createUserRepository(testDb);

beforeAll(async () => {
  await setupTestDatabase();
});
afterAll(async () => {
  await teardownTestDatabase();
});
beforeEach(async () => {
  await cleanTables();
});

describe('UserRepository', () => {
  it('creates and retrieves a user', async () => {
    const user = await userRepo.create({
      workosId: 'user_01ABC',
      email: 'test@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    const found = await userRepo.findByEmail('test@example.com');
    expect(found).toBeDefined();
    expect(found!.workosId).toBe('user_01ABC');
  });

  it('returns null for non-existent user', async () => {
    const found = await userRepo.findByEmail('nope@example.com');
    expect(found).toBeNull();
  });

  it('respects soft delete', async () => {
    const user = await userRepo.create({
      /* ... */
    });
    await userRepo.softDelete(user.id);

    const found = await userRepo.findById(user.id);
    expect(found).toBeNull(); // Soft-deleted users excluded by default
  });
});
```

### Test Database in CI

Add a PostgreSQL service in GitHub Actions:

```yaml
services:
  postgres:
    image: supabase/postgres:15.6.1.143
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: balo_test
    ports:
      - 54322:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

## E2E Tests (Playwright)

### When: Critical user journeys that cross multiple pages/systems

Keep the E2E suite small and focused on golden paths. These are the slowest, most expensive tests to maintain. Target 10-15 tests covering flows that make or lose money.

### Golden Path Tests for Balo

```
e2e/
├── auth.spec.ts            # Sign up, sign in, forgot password, OAuth
├── onboarding.spec.ts      # Expert onboarding wizard completion
├── expert-search.spec.ts   # Search, filter, view expert profile
├── case-booking.spec.ts    # Book consultation, payment, confirmation
├── case-session.spec.ts    # Join meeting, chat, case lifecycle
├── dashboard.spec.ts       # Client and expert dashboard views
└── fixtures/
    ├── auth.ts             # Login helper, storageState for authenticated tests
    └── seed.ts             # Test data creation via API
```

### Authentication Fixture

```typescript
// e2e/fixtures/auth.ts
import { test as base } from '@playwright/test';

type AuthFixtures = {
  authenticatedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page }, use) => {
    // Fast path: use saved storage state (cookies + localStorage) from a prior login.
    // Generate once with: npx playwright test e2e/auth.spec.ts --project=setup
    // Then reference in playwright.config.ts: storageState: 'e2e/fixtures/.auth/user.json'

    // If no storage state, fall back to API-based login (faster than full UI flow):
    await page.request.post('/api/auth/test-login', {
      data: { email: 'test@example.com', password: process.env.TEST_USER_PASSWORD },
    });

    await page.goto('/dashboard');
    await page.waitForURL('/dashboard');
    await use(page);
  },
});
```

For the auth setup spec that saves storage state:

```typescript
// e2e/auth.setup.ts
import { test as setup } from '@playwright/test';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByLabel('Password').fill(process.env.TEST_USER_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('/dashboard');

  // Save auth state — subsequent tests skip the login UI entirely
  await page.context().storageState({ path: 'e2e/fixtures/.auth/user.json' });
});
```

### E2E Best Practices

- **Use `getByRole` and accessible locators** — same as component tests, mirrors real user interaction
- **Don't `waitForTimeout()`** — use `waitForSelector()`, `expect().toBeVisible()`, or `waitForResponse()`
- **Run in CI with 1 worker** — parallel E2E is flaky without isolated databases
- **Capture traces on failure** — already configured: `trace: 'on-first-retry'`
- **Test one flow per spec** — if a test does login + search + book + pay, break it into focused specs with shared auth state

## Mocking External Services

### WorkOS

```typescript
// src/test/mocks/workos.ts
import { vi } from 'vitest';

export const mockWorkOS = {
  userManagement: {
    authenticateWithCode: vi.fn().mockResolvedValue({
      user: {
        id: 'user_01ABC',
        email: 'test@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        profilePictureUrl: null,
      },
      accessToken: 'mock_access_token',
      refreshToken: 'mock_refresh_token',
    }),
    authenticateWithPassword: vi.fn(),
    createUser: vi.fn(),
    getUser: vi.fn(),
  },
};

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(() => mockWorkOS),
}));
```

### Stripe

Balo uses a **single Stripe account** (not Connect). `accounts` and `transfers` are Connect objects — do not include them. The mock should reflect actual Balo usage: Checkout Sessions, PaymentIntents, and webhooks.

```typescript
// src/test/mocks/stripe.ts
import { vi } from 'vitest';

export const mockStripe = {
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/pay/cs_test_123',
        payment_status: 'unpaid',
        metadata: {},
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'cs_test_123',
        payment_status: 'paid',
        metadata: { caseId: 'case_test_1', userId: 'user_test_1' },
      }),
    },
  },
  paymentIntents: {
    retrieve: vi.fn().mockResolvedValue({
      id: 'pi_test_123',
      status: 'succeeded',
      amount: 5000,
      currency: 'aud',
    }),
  },
  webhooks: {
    constructEvent: vi.fn().mockImplementation((body, sig) => {
      if (sig === 'invalid')
        throw new Error('No signatures found matching the expected signature for payload');
      return JSON.parse(typeof body === 'string' ? body : body.toString());
    }),
  },
};

vi.mock('stripe', () => ({
  default: vi.fn(() => mockStripe),
}));
```

### Supabase Client (for component tests)

```typescript
// src/test/mocks/supabase.ts
import { vi } from 'vitest';

export const mockSupabase = {
  channel: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnValue({ status: 'SUBSCRIBED' }),
    unsubscribe: vi.fn(),
    send: vi.fn(),
  }),
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  }),
};

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => mockSupabase),
}));
```

### BullMQ

Any route or service that enqueues jobs must mock the queue — otherwise tests will attempt to connect to Redis and either fail or silently process real jobs.

```typescript
// src/test/mocks/bullmq.ts
import { vi } from 'vitest';

export const mockQueue = {
  add: vi.fn().mockResolvedValue({ id: 'job_test_1' }),
  getJob: vi.fn(),
  close: vi.fn(),
};

// Mock the queue module — the import path depends on where your queue is instantiated
vi.mock('@/lib/queues/payout', () => ({
  payoutQueue: mockQueue,
}));

vi.mock('@/lib/queues/notifications', () => ({
  notificationQueue: mockQueue,
}));
```

**In webhook route tests:** After calling the route, assert the queue job was enqueued with the expected payload:

```typescript
it('enqueues a BullMQ job for async processing', async () => {
  await app.inject({ method: 'POST', url: '/webhooks/airwallex', ... });

  expect(mockQueue.add).toHaveBeenCalledWith(
    'process-airwallex-webhook',
    expect.objectContaining({ event: expect.objectContaining({ name: 'payout.transfer.paid' }) })
  );
});
```

### Airwallex

```typescript
// src/test/mocks/airwallex.ts
import { vi } from 'vitest';

export const mockAirwallexRequest = vi.fn();

// Mock the internal request helper — everything goes through it
vi.mock('@/services/airwallex/client', () => ({
  airwallexRequest: mockAirwallexRequest,
}));

// Common resolved values — override per-test with mockResolvedValueOnce
export const mockBeneficiarySchema = {
  fields: [
    {
      path: 'beneficiary.bank_details.account_name',
      required: true,
      enabled: true,
      rule: { type: 'string', pattern: null },
      field: { key: 'account_name', label: 'Account Name', type: 'TEXT', refresh: false },
    },
    {
      path: 'beneficiary.bank_details.bsb_number',
      required: true,
      enabled: true,
      rule: { type: 'string', pattern: '^[0-9]{6}$' },
      field: { key: 'bsb_number', label: 'BSB Number', type: 'TEXT', refresh: false },
    },
  ],
  condition: null,
};

export const mockBeneficiary = {
  id: 'benef_test_123',
  nickname: 'Jane Doe',
  status: 'VERIFIED',
};

export const mockTransfer = {
  id: 'transfer_test_123',
  status: 'PENDING',
  transfer_amount: 500.0,
  transfer_currency: 'AUD',
};
```

**Usage in webhook route tests:** The Airwallex webhook handler reads `req.rawBody`. The Fastify `inject()` mock must send a raw buffer and include the correct `x-timestamp` and `x-signature` headers. Use the same HMAC logic from the skill to pre-compute a valid signature in the test setup:

```typescript
import { createHmac } from 'crypto';

function makeAirwallexSignature(
  payload: string,
  secret: string
): { timestamp: string; signature: string } {
  const timestamp = String(Date.now());
  const sig = createHmac('sha256', secret)
    .update(timestamp + payload)
    .digest('hex');
  return { timestamp, signature: sig };
}
```

## CI Integration

### GitHub Actions Test Job

```yaml
test:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: supabase/postgres:15.6.1.143
      env:
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: postgres
        POSTGRES_DB: balo_test
      ports:
        - 54322:5432
      options: >-
        --health-cmd pg_isready
        --health-interval 10s

  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: pnpm

    - run: pnpm install --frozen-lockfile

    # Install Playwright browsers on fresh runner (required — not bundled in node_modules)
    - run: npx playwright install --with-deps

    - run: pnpm test:run
      env:
        TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:54322/balo_test

    # Build Next.js before E2E — Playwright tests against the production build
    - run: pnpm build
      working-directory: apps/web
      env:
        # Add required env vars for build here

    - run: pnpm test:e2e
      env:
        TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:54322/balo_test
```

### Coverage Gating

The philosophy is "not about hitting numbers" — but CI should still gate on **coverage regression** (not absolute thresholds). Configure `vitest.config.ts` to fail if changed files drop below their existing coverage:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Gate on changed files only — avoids penalising legacy code
      // Use: pnpm test:coverage --changed HEAD~1
      thresholds: {
        perFile: true,
        lines: 70, // minimum for any modified file
        functions: 70,
        branches: 60,
      },
    },
  },
});
```

Run in CI with `pnpm test:coverage --reporter=lcov` and upload to your coverage tool. The goal is no regressions on files you touched, not 100% on everything.

## Task-Level Guidance

When a Linear task includes "Write tests per the testing skill", use this decision tree:

1. **Does the task touch Zod schemas or validation?** → Write unit tests for every rule
2. **Does the task touch price calculations or fee logic?** → Write unit tests with edge cases (rounding, zero, negative)
3. **Does the task add/modify a repository method?** → Write DB integration tests
4. **Does the task add/modify an API route?** → Write Fastify inject tests
5. **Does the task add a Server Action?** → Write integration tests mocking external services
6. **Does the task add an interactive component with >2 states?** → Write component tests
7. **Does the task complete a user journey (auth, booking, payment)?** → Write/update E2E spec
8. **Does the task add a presentational component?** → Skip tests. Move on.

## Updating Test Infrastructure

When adding new providers to the app (e.g., QueryClientProvider, ThemeProvider):

- Update `apps/web/src/test/utils.tsx` → add provider to `AllProviders` wrapper
- Update `apps/web/src/test/setup.ts` → add any global mocks needed

When adding new external service integrations:

- Create a mock in `src/test/mocks/{service}.ts`
- Document the mock pattern in this skill's references/
