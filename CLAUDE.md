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
│   ├── shared/                    Cross-app types, errors, logging
│   ├── ui/                        Shared UI primitives (future)
│   ├── eslint-config/             Shared ESLint config
│   └── typescript-config/         Shared tsconfig
└── .claude/
    ├── skills/                    Balo-specific patterns (READ THESE)
├── .agents/
│   └── skills/                    Vendor skills (installed via `npx skills`)
    └── commands/                  Agent definitions + slash commands (design, architect, build, dba, review, secure, ux-review, implement)
```

## Tech Stack

| Layer          | Technology                       | Notes                               |
| -------------- | -------------------------------- | ----------------------------------- |
| Frontend       | Next.js 14 (App Router)          | Server components by default        |
| Backend API    | Fastify                          | Zod validation on all inputs        |
| Database       | Supabase (Postgres)              | Drizzle ORM with postgres-js driver |
| Auth           | WorkOS                           | Custom UI (not hosted AuthKit)      |
| Payments       | Stripe Connect                   | Australia region, 25% markup model  |
| Queue          | BullMQ on Redis (Railway)        | Background jobs, notifications      |
| UI             | Shadcn/ui + shadcnspace + Motion | Monday.com-inspired density         |
| Styling        | Tailwind CSS                     | CSS variables for theming           |
| Real-time      | Supabase Realtime                | Case-centric chat (in-house)        |
| Search         | Algolia                          | Expert discovery                    |
| Analytics      | PostHog                          | Feature flags + product analytics   |
| Error tracking | Sentry                           | Separate projects for web + API     |
| Email          | Resend                           | Via notification engine (BullMQ)    |
| Video          | Daily.co                         | Call Object SDK for custom UI       |
| File storage   | Cloudflare R2                    | S3-compatible                       |
| Deployment     | Vercel (web) + Railway (API)     | Auto-deploy from GitHub             |

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
- No `console.log` — use structured logging (`@balo/shared` logger)
- No commented-out code or dead code

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

### Auth Model

- **Platform level:** `users.platformRole` enum (`user`, `admin`, `super_admin`)
- **Organization level:** Derived from `company_members.role` / `agency_members.role`
- **Expert status:** Derived from `expert_profiles` existence + `approvedAt`
- **Active view:** `users.activeMode` enum (`client`, `expert`)
- WorkOS handles identity. Balo handles authorization and user data.
- Custom UI modals (not hosted AuthKit redirect)
- Session via iron-session with 7-day cookie (`balo_session`)

### Notifications

- Feature code publishes domain events via `notificationEvents.publish()`
- Notification engine (BullMQ) resolves rules, selects channels, delivers
- Feature code NEVER imports Resend, writes to notification tables, or sends email directly

### UI

- Shadcn/ui base → shadcnspace enhanced → Balo custom components
- Geist Sans primary font
- CSS variables for all colors (light + dark)
- Monday.com-level spacious density (not Linear-compact)
- Dark mode from day one via `next-themes`
- All four states on every async component: loading, empty, error, success
- Toast (Sonner) on every user-initiated mutation
