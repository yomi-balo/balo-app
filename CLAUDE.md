# CLAUDE.md — Balo Platform

## What is Balo?

Balo is a B2B marketplace connecting businesses with technology consultants (starting with Salesforce). Three engagement models: Cases (per-minute consultations), Projects (custom SOW), and Packages (productized services). Revenue via 25% markup on consultant rates with a prepaid credit system.

> **Note:** This is a complete rewrite from a Bubble.io app. Any screenshots or descriptions of the existing production app (balo.expert) are for **feature/workflow reference only** — not a design or UX guide. The new platform should be significantly better in both UI and UX.

## Architecture

```
balo-app/                          Turborepo monorepo
├── apps/
│   ├── web/                       Next.js 14 (App Router) → Vercel
│   │   └── src/
│   │       ├── app/               Routes, layouts, pages, API routes
│   │       ├── components/        React components (providers, layout, UI)
│   │       ├── lib/               Auth, analytics, logging, utilities
│   │       └── middleware.ts      Request ID logging, route protection
│   ├── api/                       Fastify + BullMQ → Railway
│   │   └── src/
│   │       ├── app.ts             Fastify app setup
│   │       ├── index.ts           Server entry point
│   │       └── routes/            API route handlers
│   └── docs/                      Internal documentation site
├── packages/
│   ├── db/                        Drizzle ORM schemas, migrations, repositories
│   │   └── src/
│   │       ├── schema/            Table definitions (one file per domain)
│   │       ├── repositories/      Data access layer (no raw queries elsewhere)
│   │       └── client.ts          Drizzle client (postgres-js driver)
│   ├── analytics/                 PostHog tracking (client + server)
│   ├── shared/                    Cross-app types, errors, logging
│   ├── ui/                        Shared UI primitives (future)
│   ├── eslint-config/             Shared ESLint config
│   └── typescript-config/         Shared tsconfig
├── .claude/
│   ├── skills/                    Balo-specific patterns (READ THESE)
│   └── commands/                  Agent definitions + slash commands (design, architect, build, dba, review, secure, ux-review, implement)
└── .agents/
    └── skills/                    Vendor/third-party skills only (npx skills) — never put Balo skills here
```

## Tech Stack

| Layer          | Technology                       | Notes                                                                             |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Frontend       | Next.js 14 (App Router)          | Server components by default                                                      |
| Backend API    | Fastify                          | Zod validation on all inputs                                                      |
| Database       | Supabase (Postgres)              | Drizzle ORM with postgres-js driver                                               |
| Auth           | WorkOS                           | Custom UI (not hosted AuthKit)                                                    |
| Payments       | Stripe (single account)          | Client payments only, 25% markup. Expert payouts via Airwallex                    |
| Queue          | BullMQ on Redis (Railway)        | Background jobs, notifications                                                    |
| UI             | Shadcn/ui + shadcnspace + Motion | Monday.com-inspired density                                                       |
| Styling        | Tailwind CSS                     | CSS variables for theming                                                         |
| Real-time      | Ably                             | Case-centric chat                                                                 |
| Search         | PostgreSQL FTS (pg_trgm + GIN)   | Expert discovery — no external service                                            |
| Analytics      | PostHog                          | Feature flags + product analytics                                                 |
| Error tracking | Sentry                           | Errors, release health, tracing — web project `balo-web` (org `balo-tecnologies`) |
| Logs           | Axiom + Pino                     | Structured operational logs (dataset `balo-logs`)                                 |
| Code quality   | SonarQube / SonarCloud           | CI static-analysis quality gate (PR gate)                                         |
| Email          | Brevo + React Email              | Via notification engine (BullMQ)                                                  |
| Video          | Daily.co                         | Call Object SDK for custom UI                                                     |
| File storage   | Cloudflare R2                    | S3-compatible                                                                     |
| Deployment     | Vercel (web) + Railway (API)     | Auto-deploy from GitHub                                                           |

> **Not used (deliberately):** No Algolia — Postgres FTS instead. Supabase is Postgres only — no Supabase Realtime (use Ably), Storage (use R2), or Auth (use WorkOS). No Stripe Connect — single Stripe account; expert payouts via Airwallex.

## Skills — READ BEFORE CODING

Skills define exact patterns for this codebase. Balo-specific skills live in `.claude/skills/`, vendor skills (e.g., Vercel React best practices) live in `.agents/skills/`. **Always read relevant skills before writing code.** Do not improvise patterns that a skill already defines.

| Skill                       | When to read                                                    |
| --------------------------- | --------------------------------------------------------------- |
| `balo-ui-skill`             | Any UI work — components, pages, layouts, animations, dark mode |
| `workos-auth`               | Auth flows, session handling, protected routes, middleware      |
| `drizzle-schema`            | Schema changes, migrations, repositories, queries, transactions |
| `notification-engine-skill` | Event publishing, email delivery, BullMQ notification jobs      |

## Key Commands

```bash
# Development
pnpm dev                    # Start all apps (web :3000, api :3001)
pnpm build                  # Build all apps
pnpm typecheck              # TypeScript checks across all packages

# Testing
pnpm test                   # Run vitest (watch mode)
pnpm test:run               # Run vitest (single run)
pnpm test:integration       # Run integration tests (requires Docker)
pnpm test:e2e               # Run Playwright E2E tests

# Database (run from packages/db/)
pnpm db:generate            # Generate migration from schema changes
pnpm db:push                # Push schema to dev DB (dev only, never production)
pnpm db:migrate             # Apply migrations (production)
pnpm db:studio              # Open Drizzle Studio

# Code quality
pnpm lint                   # ESLint
pnpm lint:fix               # ESLint with auto-fix
pnpm format                 # Prettier
pnpm format:check           # Prettier check
```

## Code Conventions

### TypeScript

- No `any` — use `unknown` and narrow with type guards
- Explicit return types on exported functions
- No commented-out code or dead code
- `noUncheckedIndexedAccess` is on: `arr[0]` / `record[key]` is `T | undefined`. Narrow by destructure + guard (`const [first] = ids; if (first === undefined) return;`), not with `!`. SonarCloud analyzes without this flag, so it flags index-position `!` as "unnecessary" — a false positive; fix by guarding, and re-run `pnpm typecheck` after touching any assertion.

### Logging

**Never use `console.log` / `console.error` in application code** (exception: `middleware.ts` Edge Runtime where Pino can't run — use structured `JSON.stringify` there).

The logging infrastructure auto-handles most things. You only need to add manual logging at **caught error boundaries** — places where you catch an error and return a user-friendly message:

```typescript
import { log } from '@/lib/logging'; // web app — has AsyncLocalStorage context (requestId, userId auto-attached)
import { createLogger } from '@balo/shared/logging'; // packages or API — create scoped child logger

// In every catch block that handles (not re-throws) an error:
log.error('Sign-in failed', {
  email, // context needed to debug — never log passwords or tokens
  error: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
});
```

**What's already automatic (don't duplicate):**

- Request logging → middleware (structured JSON with requestId)
- DB query logging → Drizzle logger hook in `packages/db/src/client.ts`
- Unhandled errors → Sentry `onRequestError` in `instrumentation.ts`
- Request context → AsyncLocalStorage mixin attaches `requestId` + `userId` to every log

**What you must add manually:**

- `log.error()` in every catch block that returns a user-facing error (the original error gets lost otherwise)
- `log.info()` for key business events: sign-in, sign-up, OAuth callback, onboarding completion, payment events
- `log.warn()` for recoverable issues: session refresh fallbacks, missing optional data, validation anomalies

**For external API calls**, use the `loggedFetch` wrapper instead of bare `fetch`:

```typescript
import { loggedFetch } from '@/lib/logging/fetch-wrapper';

const response = await loggedFetch('https://api.stripe.com/v1/charges', {
  service: 'stripe', // appears in logs for filtering
  method: 'POST',
  headers: { Authorization: `Bearer ${key}` }, // auto-redacted by Pino
  body: JSON.stringify(data),
});
```

### React / Next.js

- Server Components by default, `"use client"` only for interactivity
- Server Actions for mutations (not API routes from the frontend)
- Error boundaries for every new route segment
- Loading states for every async operation

### Database

- All queries go through repositories in `packages/db/src/repositories/`
- Never write raw queries in API routes, Server Actions, or components
- Every table: `id` (UUID), `created_at`, `updated_at` (with timezone)
- Soft deletes via `deleted_at` timestamp — every table gets it
- Foreign keys explicit with ON DELETE behaviour specified

### Integration Tests

Any new file added to `packages/db/src/repositories/` **must** include a corresponding
`*.integration.test.ts` file in the same PR. Integration tests run against a real
Postgres 16 instance via Testcontainers.

- Unit tests (`*.test.ts`): mock all repository calls — fast, no DB required
- Integration tests (`*.integration.test.ts`): real Postgres, transaction rollback per test
- Run with: `pnpm test:integration` (requires Docker)

Do not add new repository files without integration tests. SonarQube will flag coverage regression.

### Auth Model

- **Platform level:** `users.platformRole` enum (`user`, `admin`, `super_admin`)
- **Organization level:** Derived from `company_members.role` / `agency_members.role`
- **Expert status:** Derived from `expert_profiles` existence + `approvedAt`
- **Active view:** `users.activeMode` enum (`client`, `expert`)
- WorkOS handles identity. Balo handles authorization and user data.
- **Authorization is capability-based (ADR-1029).** Resolve `hasCapability(...)` at every call site — never gate on `platformRole ===`, `role ===`, or `activeMode ===`. Roles (`owner`/`admin`/`member`/`finance`), additive `member_capability_overrides`, and `representations` (AE / account-manager act-on-behalf) are capability bundles; `activeMode` is a view toggle, never an authorization input.
- Custom UI modals (not hosted AuthKit redirect)
- Session via iron-session with 7-day cookie (`balo_session`)

### Analytics

Event definitions and tracking wrappers live in `packages/analytics` (`@balo/analytics`), shared across `apps/web` (client) and `apps/api` (server). Three subpath exports: `@balo/analytics/client`, `@balo/analytics/server`, `@balo/analytics/events`.

**Client-side tracking (browser)** — use the typed `track()` function:

```typescript
import { track, AUTH_EVENTS } from '@/lib/analytics';

track(AUTH_EVENTS.LOGIN_COMPLETED, { method: 'email', is_returning_user: true });
```

**Server-side tracking (API/workers)** — use `trackServer()`:

```typescript
import { trackServer, EXPERT_PAYOUT_SERVER_EVENTS } from '@balo/analytics/server';

trackServer(EXPERT_PAYOUT_SERVER_EVENTS.AIRWALLEX_BENEFICIARY_REGISTERED, {
  method: 'LOCAL',
  country_code: 'AU',
  beneficiary_status: 'verified',
  distinct_id: userId,
});
```

`trackServer` is a no-op when `POSTHOG_API_KEY` is not set (dev, CI).

**Adding a new feature's events:**

1. Create `packages/analytics/src/events/<feature>.ts` with `<FEATURE>_EVENTS` constants + `<Feature>EventMap` interface
2. Re-export from `packages/analytics/src/events/index.ts`
3. Add `& <Feature>EventMap` to `AllEvents` in `packages/analytics/src/types.ts`
4. For server-only events: add `<FEATURE>_SERVER_EVENTS` + `<Feature>ServerEventMap` and extend `ServerEvents` in `types.ts`

**Event naming convention:**

- Constant: `AUTH_EVENTS.LOGIN_COMPLETED` (SCREAMING_SNAKE)
- Value: `'auth_login_completed'` (snake_case with feature prefix)
- Pattern: `{feature}_{noun}_{past_tense_verb}`

**`analytics.identify()` calls:**

- After sign-in / sign-up success: `analytics.identify(userId, { email, active_mode, platform_role })`
- PostHogProvider auto-identifies on page load if session exists
- On logout: `analytics.reset()` (clears distinct_id)

**Testing:**

- Global mock in `apps/web/src/test/setup.ts` silences analytics in all tests
- Client: `import { track } from '@/lib/analytics'; expect(track).toHaveBeenCalledWith(AUTH_EVENTS.LOGIN_COMPLETED, { ... })`
- Server: mock `posthog-node` and assert `capture` was called with the correct `distinctId`, `event`, and `properties`

### Notifications

- Feature code publishes domain events via `notificationEvents.publish()`
- Notification engine (BullMQ) resolves rules, selects channels, delivers
- Feature code NEVER imports Brevo, writes to notification tables, or sends email directly

### UI

- Shadcn/ui base → shadcnspace enhanced → Balo custom components
- Geist Sans primary font
- CSS variables for all colors (light + dark)
- Monday.com-level spacious density (not Linear-compact)
- Dark mode from day one via `next-themes`
- All four states on every async component: loading, empty, error, success
- Design source of truth: interactive JSX prototypes in `.claude/design-references/` define layout, spacing, colour, Lucide icons, and animation. Implement from the referenced prototype; the Bubble app is workflow reference only, never a UI guide.
- Empty states: hiding is the exception. If the user could act in an empty section, KEEP it with invitation copy ("Start a project with {name}"), never absence-framed ("No X yet"). Hide only purely retrospective data the user can't act on (reviews, completed history), with justification.
- Toast (Sonner) on every user-initiated mutation

## Copy & Microcopy

All user-facing copy (UI, email, in-app, prototypes):

- **Gender-neutral** — never gendered pronouns for clients or experts; use names, "they", or restructure.
- **Tone** — warm and congratulatory at milestone moments (delivery, completion, acceptance); state deadlines and auto-accept as helpful facts ("take until {date} — no rush; if it slips by we close it out as delivered so nothing is left hanging"), never adversarial or countdown-led.
- **Attribution (by tense, symmetric for both sides):**
  - _Prospective_ copy (who can act, who's notified, whose review window) names the **party** — the client company ("Northwind has 7 days to review") and, for agency-based experts, the agency ("CloudPeak marks each milestone"; independent experts keep their own name).
  - _Retrospective_ copy (who actually did something) names the **person** with "@ company/agency" on first mention, bare name after ("Accepted by Dana @ Northwind Industrial", then "Dana …").
  - Rights sit on company/agency membership (ADR-1029) and survive individual departures; attribution columns record the individual actor.
