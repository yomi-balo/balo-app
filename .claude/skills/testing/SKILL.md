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
import { axe, toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

it('has no accessibility violations', async () => {
  const { container } = render(<AuthModal defaultView="login" open onOpenChange={vi.fn()} />);
  expect(await axe(container)).toHaveNoViolations();
});
```

Install: `pnpm --filter web add -D jest-axe @types/jest-axe`

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
    // Use storageState from a pre-authenticated session
    // OR perform login via API shortcut (faster than UI login)
    await page.goto('/');
    // ... login steps
    await use(page);
  },
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

### Stripe Connect

```typescript
// src/test/mocks/stripe.ts
import { vi } from 'vitest';

export const mockStripe = {
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/test',
      }),
    },
  },
  accounts: {
    create: vi.fn().mockResolvedValue({ id: 'acct_test_123' }),
  },
  transfers: {
    create: vi.fn().mockResolvedValue({ id: 'tr_test_123' }),
  },
  webhooks: {
    constructEvent: vi.fn().mockImplementation((body) => JSON.parse(body)),
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
    - run: pnpm test:run
      env:
        TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:54322/balo_test
    - run: pnpm test:e2e
      env:
        TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:54322/balo_test
```

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
