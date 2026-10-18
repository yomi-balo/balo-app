# Help screenshots

Playwright runner that captures the PNGs the help-centre guides embed. Each capture signs in through
the test-login seam, opens a seeded page, draws a numbered ring around one element, clips around it,
removes the ring, and writes a lossless PNG to `apps/web/public/help/<slug>/<nn>-{light,dark}.png`
(`<nn>` is the zero-padded `##` section number of `docs/help/<slug>.md`).

The runner is **not** part of `pnpm test:e2e` or CI: the root `playwright.config.ts` ignores this
folder, because the runner seeds a fixture into the database and writes files into the repo.

## Prerequisites

- Docker Postgres and Redis running, with `pnpm db:migrate` and `pnpm db:seed` applied (the fixture
  needs the Salesforce vertical).
- The `apps/web` dev server (:3000) **and** the API (:3002) running against the same local database.
  The pages fetch hours, calendars and schedule through the API; the runner's `webServer` only
  starts web (`pnpm dev` at the repo root starts both). Web needs `E2E_TEST_SECRET` and
  `WORKOS_COOKIE_PASSWORD` set.
- `E2E_TEST_SECRET` exported in the shell that runs the command, with the same value.
- `packages/db/.env` must point at the **same** database as the web server, and that database must be
  local. The seed CLI refuses to run (all three commands) unless the `DATABASE_URL` host is
  `localhost`, `127.0.0.1` or `::1`: the fixture hard-deletes and rewrites rows, and the shared
  balo-dev database also backs deployed apps.

## Commands

```bash
pnpm help:screenshots                      # every guide in guides/
pnpm help:screenshots pausing-new-work     # one guide (the arg filters guides/<slug>.ts)
pnpm --filter @balo/db help:reset          # remove the fixture when you are done
```

The runner's global teardown runs `help:reset` automatically, so a finished run leaves no fixture
behind. Set `HELP_KEEP_FIXTURE=1` to skip it and inspect the seeded data; run `help:reset` yourself
afterwards. Reset removes everything the fixture added
(Priya's expert profile, availability rules, calendar connection, payout row, the case, consultation and meeting) and hands the
shared `onboarded-e2e@balo.test` user back as test-login creates it, so the default e2e suite's
member is not left an expert.

## The fixture

`packages/db/src/help-seed/` seeds, with fixed ids, on every run:

- **Priya Raman**: the `onboarded-e2e@balo.test` user (seeding refuses if that row carries a staff
  role or capability override), with an avatar and a verified phone, plus an approved independent
  Salesforce expert profile (`/experts/priya-raman`, rate 300 cents/min), Mon-Fri 09:00-17:00
  availability, an ACTIVE calendar connection and a payout row. Those satisfy all six searchability
  checklist items, so visiting the dashboard never flips her profile to unlisted.
- **Northwind Industrial**: a client company owned by **Dana Whitfield** (`dana-help@balo.test`,
  never signs in).
- A confirmed consultation between them on the coming Monday, 14:00-15:00 UTC.

Each section declares `state: 'available' | 'paused'`; the runner applies it with `help:state`
before navigating, so sections do not depend on run order.

## Personas

`as` is `'expert'` (the seeded Priya Raman) or `'visitor'` (signed out). There is no `'client'`
persona yet: it is a type error until BAL-599 rules on how a client signs in.

Every capture fails if the page emits a `pageerror` or a `console.error`, listing them.

## Adding a guide

1. Create `guides/<slug>.ts` and call `defineGuide('<slug>', [...])`. One entry per `##` section
   that needs a screenshot; `section` is the section's ordinal and also the badge number.
2. Add `![alt](<nn>)` (for example `](03)`) to section _nn_ of `docs/help/<slug>.md`.
   `defineGuide` throws at load time if a `section` is duplicated, out of range, or has no image ref; it also throws if the doc has an image ref no spec section covers.
3. Choose the frame with `crop` (a locator) plus `cropPadding`, or `cropArea(page, targetBox)` to
   return an exact box in viewport coordinates (for example one card's width but only part of its
   height). `cropArea` wins over `crop`.
4. Prefer role and text locators for `target` and `crop`. Keep the clip inside 1280x800; the runner
   throws rather than shooting the full page.
5. Run `pnpm help:screenshots <slug>` and check both the light and dark PNGs.

## Reproducibility

The browser clock is frozen to 09:00 UTC on the anchor Monday, but the server reads the real clock.
Two runs on unchanged code are identical only within the same calendar week, and crops avoid date
labels where practical.
