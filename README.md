# Balo App

Monorepo powered by [Turborepo](https://turborepo.dev) with pnpm workspaces.

## Apps and Packages

- `apps/web` — Next.js frontend
- `apps/api` — Fastify backend
- `apps/docs` — Next.js documentation site
- `packages/db` — Shared Drizzle ORM database package (`@balo/db`)
- `packages/ui` — Shared React component library (`@repo/ui`)
- `packages/eslint-config` — Shared ESLint configurations (`@repo/eslint-config`)
- `packages/typescript-config` — Shared TypeScript configurations (`@repo/typescript-config`)

## Getting Started

```sh
pnpm install
pnpm dev
```

## Scripts

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `pnpm dev`          | Start all apps in development mode    |
| `pnpm build`        | Build all apps and packages           |
| `pnpm lint`         | Lint all packages                     |
| `pnpm lint:fix`     | Lint and auto-fix                     |
| `pnpm format`       | Format all files with Prettier        |
| `pnpm format:check` | Check formatting without writing      |
| `pnpm typecheck`    | Run type checking across all packages |

## Testing

### Unit and Integration Tests (Vitest)

```sh
pnpm test              # Watch mode
pnpm test:run          # Single run
pnpm test:coverage     # Single run with coverage report
```

Run tests for a single app:

```sh
pnpm --filter web test:run
pnpm --filter api test:run
```

### End-to-End Tests (Playwright)

First-time setup (downloads browser binaries):

```sh
npx playwright install
```

Run tests:

```sh
pnpm test:e2e          # Headless, all browsers (Chromium, Firefox, WebKit)
pnpm test:e2e:ui       # Interactive UI mode
```

## Database

The shared database package lives in `packages/db` and uses Drizzle ORM with PostgreSQL.

```sh
pnpm --filter @balo/db db:generate   # Generate migrations
pnpm --filter @balo/db db:migrate    # Run migrations
pnpm --filter @balo/db db:push       # Push schema to database
pnpm --filter @balo/db db:studio     # Open Drizzle Studio
```
