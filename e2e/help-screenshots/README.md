# Help screenshots

Playwright runner that captures the PNGs the help-centre guides embed. Each capture signs in through
the test-login seam, opens a seeded page, draws a numbered ring around one element, clips around it,
removes the ring, and writes a losslessly compressed PNG to `apps/web/public/help/<slug>/<nn>-{light,dark}.png`
(`<nn>` is the zero-padded `##` section number of `docs/help/<slug>.md`).

The runner is **not** part of `pnpm test:e2e` or CI: the root `playwright.config.ts` ignores this
folder, because the runner seeds a fixture into the database and writes files into the repo.

## Prerequisites

- Docker Postgres and Redis running, with `pnpm db:migrate` and `pnpm db:seed` applied (the fixture
  needs the Salesforce vertical).
- `apps/web` as a **production build** (:3000) and the API (:3002, `pnpm dev`) running against the
  same local database. The runner's `webServer` builds and starts web (`pnpm build && pnpm start`
  in `apps/web`) unless a server is already on :3000, which is reused. A dev server there is refused at
  start-up: React hydration ids drift when chunks compile on demand, which fails the console gate. After a UI change, rebuild web
  before capturing. The pages fetch hours, calendars and schedule through the API, which the
  runner does not start. Web needs `E2E_TEST_SECRET` and `WORKOS_COOKIE_PASSWORD` set.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` set when web is built (it is inlined at build time): the top-up page renders its
  payment form from it (`TopUpComposer.tsx`), so guides that show that page need it.
- `E2E_TEST_SECRET` exported in the shell that runs the command, with the same value.
- `packages/db/.env` must point at the **same** database as the web server, and that database must be
  local. The seed CLI refuses to run (all three commands) unless the `DATABASE_URL` host is
  `localhost`, `127.0.0.1` or `::1`: the fixture hard-deletes and rewrites rows, and the shared
  balo-dev database also backs deployed apps.

Run captures **alone**: no parallel test runs, agents or second runner on the machine. Hydration
only misbehaves under load (a Radix `useId` mismatch when chunks load slowly), and the runner does
not filter or retry console errors.

## Commands

```bash
pnpm help:screenshots                      # every guide in guides/
pnpm help:screenshots pausing-new-work     # one guide (the arg filters guides/<slug>.ts)
pnpm --filter @balo/db help:reset          # remove the fixture when you are done
```

The runner's global teardown runs `help:reset` automatically, so a finished run leaves no fixture
behind. Set `HELP_KEEP_FIXTURE=1` to skip it and inspect the seeded data; run `help:reset` yourself
afterwards. Reset removes everything the fixture added
(Priya's expert profile, availability rules, calendar connection, payout row, Northwind and its wallet, the case, consultation, meeting and guest) and hands both
shared test-login users (`onboarded-e2e@balo.test` and `dana-help@balo.test`) back as test-login
creates them (`E2E` `Test`, no active company), so the default e2e suite's member is not left an
expert. It also deletes any money rows the running API wrote against the fixture wallet.

## The fixture

`packages/db/src/help-seed/` seeds, with fixed ids (`constants.ts`), on every run:

- **Priya Raman**: the `onboarded-e2e@balo.test` user (seeding refuses if that row carries a staff
  role or capability override), with an avatar and a verified phone, plus an approved independent
  Salesforce expert profile (`/experts/priya-raman`, rate 300 cents/min), Mon-Fri 09:00-17:00
  availability, an ACTIVE calendar connection with a primary sub-calendar (conflict checks off, so
  slot reads never call a calendar vendor) and a payout row. Those satisfy all six searchability
  checklist items, so visiting the dashboard never flips her profile to unlisted.
- **Dana Whitfield**: the `dana-help@balo.test` test-login user, dressed as the owner of
  **Northwind Industrial** with Northwind as her active workspace. Northwind has a funded credit
  wallet (A$1,240.00, matching ledger purchase row, keep-going mode) with a live card mandate and a
  saved Visa ending 4242.
- A confirmed consultation between them on the coming Monday, 14:00-15:00 UTC, with a call room
  and one email-invited guest (Sam Lee, a pre-admitted client-side guest; the raw invite token is
  `HELP_GUEST_TOKEN`, a local-fixture-only constant).

### States

Each section declares `state`; the runner applies it with `help:state <state> --anchor=<Monday>`
before navigating, so sections do not depend on run order. Every state first restores every column
a state can change to its base value, then applies its own change, in one transaction.

| State              | Change from the base                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `available`        | none (the base)                                                                        |
| `paused`           | Priya is not available for work                                                        |
| `proposal`         | a pending reschedule proposal with three options                                       |
| `held`             | the consultation ended a quarter of an hour ago (real clock)                           |
| `calendar-pending` | the calendar connection is `SYNC_PENDING`                                              |
| `overnight`        | Friday availability runs 18:00 to 02:00                                                |
| `setup-incomplete` | the payout row is removed                                                              |
| `rejected`         | the application was rejected seven days ago (inside the cooldown)                      |
| `client-member`    | Dana is a Northwind `member`, not the owner                                            |
| `auto-closed`      | a second Northwind case with Priya was closed automatically ten days before the anchor |

## Personas

`as` is `'expert'` (Priya Raman, through the `member` test-login persona), `'client'` (Dana
Whitfield in Northwind, through the `help-client` persona) or `'visitor'` (signed out).
`help-client` is a closed persona on the secret-gated test-login route: it resolves to the fixed
address `dana-help@balo.test`, no request body can name an email, and the seed sets her active
workspace to Northwind so the minted session lands there. `signIn` is an exhaustive `switch`, so a
new persona is a type error until it is handled.

Before each section is captured, its route is warmed once per scheme pass: the runner navigates to
it, waits for `networkidle`, then navigates again for the real capture, so the route's chunks and
fonts are cached before the visit that hydrates.

Every capture fails if the page emits a `pageerror` or a `console.error`; both lists are printed
and nothing is filtered.

## PNG storage

PNGs stay in git. The runner only writes a file when the capture decodes to different pixels from
the file on disk (decoded RGBA, never file bytes), so re-running every guide after a small UI
change commits only the screens that changed. Each written file is compressed losslessly with
oxipng (`@jsquash/oxipng`) and checked to decode to exactly the captured pixels. Each file prints
`written` or `unchanged`. If `apps/web/public/help/` ever passes about 50 MB, flag it and move the
images to Git LFS.

`pnpm typecheck:e2e` typechecks this folder and the other `e2e/` specs; CI runs it.

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
