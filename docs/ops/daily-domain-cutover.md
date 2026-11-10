# Daily domain cutover — ops runbook

**Audience:** Balo admins and on-call engineers. Internal operations document, not customer-facing
help copy (that lives in `docs/help/`).

Moves Balo's platform off the Bubble app's shared Daily domain (`getbalo`) onto its own Daily
account, with separate production and non-production domains (BAL-518). The agents that built the
tooling run none of these steps: the account, keys, webhook and env changes are yours.

For the vendor contract and the traps behind each step, see `.claude/skills/daily-co/SKILL.md`
(§ Webhooks, § Domains and environments).

---

## What changes

Three variables change in one cutover, and they must agree:

| Variable                   | Where               | Notes                                                                      |
| -------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `DAILY_API_KEY`            | Railway (API)       | The new account's key for this environment's domain.                       |
| `DAILY_WEBHOOK_SECRET`     | Railway (API)       | Our own secret, `openssl rand -base64 32`. Also passed to Daily as `hmac`. |
| `NEXT_PUBLIC_DAILY_DOMAIN` | Vercel (web, build) | The new hostname, `<domain>.daily.co`. Inlined at build time: redeploy.    |

`meetings.join_url` persists the room's host, so every future meeting still stamped with a
`getbalo` room must be re-provisioned on the new domain. Invites and emails carry Balo's
`/meetings/{id}/call` link, never the Daily URL, so nothing is re-sent. The room name is a pure
function of `meetings.id`, so the same name is re-created on the new domain.

Two tools do the work:

- `apps/api/scripts/daily-webhook.ts` — `verify` and `sync` the per-environment webhook.
  Dry-run by default. Refuses a `getbalo` key and refuses to touch
  any subscription whose url is not Balo's.
- `apps/api/scripts/daily-venue-reprovision.ts` — nulls the venue of future `scheduled` meetings
  still stamped on the old domain. Dry-run by default. Needs only `DATABASE_URL`.

Run both from the repo root through dotenv, so no key, secret or database url ever appears on the
command line or in shell history:

```bash
npx dotenv -e <target-env-file> -- npx tsx apps/api/scripts/daily-webhook.ts verify
```

`<target-env-file>` is a git-ignored file you create for this cutover holding the **target
environment's** values (see the table above and steps 2, 5 and 6). It is never `apps/api/.env.local`:
that file points at a developer's local setup, and running a script against it checks, or worse
changes, the wrong database and the wrong Daily domain.

Webhook urls print as origin and path only. A failed Daily call prints the method, path, status and
the vendor's `error` field, with the key and secret redacted.

---

## Step 0. Preconditions

Do not start until all of these hold.

- A new Daily account on a paid plan (recording requires it), with a **production** domain and a
  **non-production** domain.
- **Confirm the env→DB map.** Only Railway "production" → balo-dev is verified. Write down which
  database each Vercel environment (Production, Preview, Development) and each Railway environment
  uses, and which Daily domain each should pair with. One Daily domain per database. **balo-dev
  pairs with the non-production domain**; the production domain stays empty until the launch
  database exists.
- **Find every API that has written to this database with a `getbalo` key.** balo-dev already
  holds meetings with `getbalo` join urls (12 as of 2026-11-06, all `ended`), so some API with a
  `getbalo` key provisioned rooms into it: Railway at some point, a local `apps/api`, or another
  deployment. List each one and move its `DAILY_API_KEY` in this cutover too. Any writer you miss
  keeps stamping `getbalo` rooms after cutover and breaks one-domain-per-database.
- **Resolve recording rows on `getbalo` rooms.** A recording on `getbalo` cannot be fetched with
  the new key, and its webhooks went to Bubble, so nothing on Balo's side will ever close a row
  that is still open. With the **old** key, find every `meeting_recordings` row whose meeting
  joined on `getbalo` and whose status is not terminal:
  - the recording exists at Daily → ingest it while the old key still works;
  - it doesn't (no `daily_recording_id`, or Daily has no such recording) → mark it failed.

  As of 2026-11-06 balo-dev has one such row in `recording` (meeting `e84fe8b7…`, since 26 Oct,
  no `daily_recording_id`), plus seven rows on meeting `2132522b…` that already failed at the
  `daily` stage and need no action.

## Step 1. Generate a secret per environment

```bash
openssl rand -base64 32
```

One value per Daily domain. Keep it out of shell history and chat. It is both
`DAILY_WEBHOOK_SECRET` and the webhook's `hmac`.

**Rotation** is the same sequence: generate a new secret, set it as `DAILY_WEBHOOK_SECRET` and
deploy, then run `daily-webhook.ts sync --apply` (step 5). `verify` reports `hmac: differs` and
`sync` plans an update ("hmac differs") while Daily still holds the old value. `verify` can only
compare the hmac when `DAILY_WEBHOOK_SECRET` is in its env file; without it, it prints
"hmac: not checked".

## Step 2. Re-provision dry-run

```bash
npx dotenv -e <target-env-file> -- \
  npx tsx apps/api/scripts/daily-venue-reprovision.ts --from-domain getbalo
```

`DATABASE_URL` in `<target-env-file>` is **the deployed database** for this environment (the one the
Railway API uses), not `apps/api/.env.local`. The script prints `Database host: …` first: the host and port plus
the Supabase **project ref**, never credentials. A Supavisor pooler host
(`aws-0-<region>.pooler.supabase.com`) is shared by every project in the region, so the
**project ref** is the only thing that identifies the database. Confirm it is the project you wrote
down in step 0 before reading on.

It prints three groups:

- **Targets**: future `scheduled` meetings it would clear.
- **Blockers**: meetings that can still start or are running. That means a `scheduled` meeting
  inside its missed-call window, or a live call until its overrun stop ceiling (the later of its
  scheduled end and start + 240 minutes, plus the 30-minute grace). **Gate: 0 blockers.**
  Blockers clear on their own as calls end, so re-run after the next one finishes.
- **Stranded**: meetings past those windows that never ended (the `meeting.stranded` admin alert,
  BAL-586, covers them). They are a warning only and do not gate the cutover. Resolve them through
  that alert, not here.

The script reads the timer overrides (`MEETING_MISSED_CALL_MINUTES`,
`MEETING_OVERRUN_STOP_GRACE_MINUTES`) from `<target-env-file>` through the API's own
`resolveMeetingTimers`, so keep them identical to Railway's. The overrun grace can only be
lengthened, never shortened below 30 minutes. With neither set, the shipped defaults apply.

A past-start `scheduled` meeting is never nulled, because nulling would turn a no-show into
`venue_unavailable`.

## Step 3. Vercel: unset `NEXT_PUBLIC_DAILY_DOMAIN` and redeploy

With it unset the web app admits any `*.daily.co` host, so it accepts both the old and new
domains across the cutover. Redeploy: the value is inlined at build time.

## Step 4. Railway: swap the key and secret in one change

Set the new `DAILY_API_KEY` and `DAILY_WEBHOOK_SECRET` together, then deploy. Setting only one
leaves the API with a key that cannot verify, or a secret Daily was never given.

## Step 5. Register the webhook

`<target-env-file>` must hold this environment's `DAILY_API_KEY` and `DAILY_WEBHOOK_SECRET`: the
**new Railway values**, identical to what the deployed API now has, never `apps/api/.env.local`.
The plan prints the domain the key belongs to; confirm it is the new domain.

Dry-run first:

```bash
npx dotenv -e <target-env-file> -- \
  npx tsx apps/api/scripts/daily-webhook.ts sync --url https://<api-origin>/webhooks/daily
```

Read the plan. Then:

```bash
npx dotenv -e <target-env-file> -- \
  npx tsx apps/api/scripts/daily-webhook.ts sync --url https://<api-origin>/webhooks/daily --apply
```

It creates or updates the subscription with `retryType: exponential` and every handled event
type, and re-runs `verify`. Recording is not a domain setting: `rooms.ts` sets `enable_recording`
per room at create, and the forced re-provision in step 6 means every live room is created fresh
on the new domain. If the plan says
`refuse`, stop: the domain is `getbalo`, or a subscription with a different url exists. Do not
delete it; the domain allows one subscription.

`--force-update` re-sends the update even when the subscription already matches.

## Step 6. Re-provision

```bash
npx dotenv -e <target-env-file> -- \
  npx tsx apps/api/scripts/daily-venue-reprovision.ts --from-domain getbalo --apply
```

Same `<target-env-file>` and the same `Database host:` check as step 2: `DATABASE_URL` is the
deployed database, never `apps/api/.env.local`.

It nulls the room name, join url and `venue_provisioned_at` on the future `scheduled` meetings
listed in step 2. It exits 1 if blockers exist. When the batch is full it says so: **re-run** until
it reports 0 targets. Re-running is safe, because cleared rows stop matching.

The venue-repair job re-creates each room on the new domain at its next checkpoint (daily, or
start-anchored 180 minutes before the meeting). Until then `meeting.unprovisioned` admin alerts
fire for those rows. This is expected; do not clear them by hand.

## Step 7. Vercel: pin the new hostname

Set `NEXT_PUBLIC_DAILY_DOMAIN=<domain>.daily.co` for the environment and redeploy.

## Step 8. Verify

- `daily-webhook.ts verify` exits 0: the subscription is `ACTIVE`, `exponential`, with the full
  event list and `hmac: matches`.
- `daily-venue-reprovision.ts --from-domain getbalo` (dry-run) shows 0 targets and 0 blockers once
  the repair job has healed the rows. Stranded rows may remain; they are the BAL-586 alert's.
- New meetings in this database get join urls on the new domain only. If a `getbalo` url appears
  after cutover, a writer from step 0 still has the old key.
- `npx dotenv -e <target-env-file> -- npx tsx apps/api/scripts/daily-token-smoke.ts` passes.

---

## Post-merge checklist (acceptance criteria)

Done by ops after the PR merges; the PR itself changes no environment.

- [ ] **AC2** The new account exists and no key from it is the `getbalo` domain's. `daily-webhook.ts`
      reports the expected domain name.
- [ ] **AC3** Each environment has its own subscription, registered with `sync --apply`.
- [ ] **AC4** Each environment's `DAILY_WEBHOOK_SECRET` is a fresh base64 secret of at least 32 bytes.
- [ ] **AC5** Non-production, including balo-dev, uses the non-prod domain and its own key.
- [ ] **AC6** Re-provision dry-run reports 0 targets and 0 blockers once healed (stranded rows are
      BAL-586's and do not count).
- [ ] **AC7** The Bubble subscription on `getbalo` is unchanged.

## Orphan rooms

Rooms created on `getbalo` for cleared meetings are not deleted, and they do **not** expire:
`createOrFindRoom` sets no `exp`, so they persist on `getbalo` until someone deletes them manually.
Deleting them is optional and needs the **old** key (the new key cannot see `getbalo`). Delete only
rooms named `balo-<uuid>`; never touch a Bubble room (any other name), because the domain still
serves Bubble.
