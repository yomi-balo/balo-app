# Balo Admin Dashboard — Technical Directions on the Six Decisions

**Source:** read directly from `balo-app` @ `main` (HEAD `50b31bc5`), 2026-09-04. Every claim below is a `file:line` I opened, not an inference from the tracker. Where the Notion tracker ("Balo Admin Dashboard — Feature & Config Tracker") disagrees with the code, the code is quoted.

**Scope:** the six ADR-before-Linear decisions raised in the admin-dashboard design conversation:

1. The pending-actions primitive (`admin_alerts`) and its sourcing model
2. Config storage (`platform_config` singleton vs. alternatives)
3. Whether an admin read of party data writes an access record
4. The admin mutation pattern — re-drive as a first-class mutator, and impersonation
5. Platform staff roles / capability bundles
6. Where admin lives in the app shell

---

## Part 0 — Three things the code contradicts, before the decisions

### 0.1 Two of the six "log-only, no surface" items are not log-only. They are broken.

**(a) `meeting-calendar-amend` has never enqueued a single job.**

`apps/api/src/jobs/meeting-calendar-amend.ts:69`:

```ts
const jobId = `meeting-calendar-amend:${rescheduleAuditId}`;
```

`rescheduleAuditId` is a bare UUID (colon-free), so the id carries **exactly one** colon. BullMQ 5.70.4 rejects any custom jobId whose colon count is not 0 or exactly 2 — `node_modules/.pnpm/bullmq@5.70.4/node_modules/bullmq/dist/cjs/classes/job.js:1036-1038`:

```js
if (this.opts?.jobId.includes(':') && this.opts?.jobId.split(':').length !== 3) {
  throw new Error('Custom Id cannot contain :');
}
```

So `enqueueMeetingCalendarAmend` throws on **every** call. Its only caller swallows it — `apps/api/src/services/meetings/meeting-availability.ts:308-313`:

```ts
).catch((error: unknown) => {
  log.error({ meetingId, error: … }, 'Failed to enqueue meeting-calendar-amend job');
});
```

And no test catches it: `apps/api/src/jobs/meeting-calendar-amend.test.ts:52` states outright that `getQueue`/`createRedisConnection` "are not exercised by `processMeetingCalendarAmend`" — the suite tests the _processor_, never the _enqueue_.

**Consequence:** BAL-409's Apiroc calendar amend has never run. Every client-initiated reschedule leaves the expert's external calendar showing the old window, silently, while Balo's own record is correct so nothing else looks wrong. **Tracker item 3.10 is wrong as written** — it says "the amend exhausts its 5 attempts (`removeOnFail: 5000`)". There are no attempts and no BullMQ failed-set entry, because the job is never created.

**(b) 3.9's in-app admin notification has never been delivered.**

Same defect class, second site. `apps/api/src/notifications/publisher.ts:54` escapes the correlationId:

```ts
export function toJobId(event: string, correlationId: string): string {
  const safeCorrelationId = correlationId.replaceAll('_', '__').replaceAll(':', '_c');
  return `${event}--${safeCorrelationId}`;
}
```

…but `apps/api/src/notifications/engine/dispatcher.ts:73` builds the **per-channel delivery** jobId from the **raw, unescaped** id:

```ts
const jobId = `${rule.template}--${recipientId}--${context.payload.correlationId}`;
```

`rule.template` and `recipientId` (a UUID) contain no colons, so the whole colon count comes from the correlationId and the split-length rule applies unchanged. Five `admin_users` events mint one-colon correlationIds and therefore throw at `channelQueue.add`: `engagement.milestone_completed`, `engagement.scope_changed`, `engagement.accepted`, `engagement.auto_accepted`, and — the one that matters here — **`calendar.subscription_lapse`**, which is 3.9's only in-app admin alert (`rules.ts:797`).

So "3.9 fans out an in-app notification to `admin_users`" is true in the rules table and false in production.

**Both fixes are ~1 line** (use `--` as the separator, as `recording-ingest--{id}` and `transcript-submit--{id}` already do). Do them before designing around their symptoms — one of them is a direct cause of "nothing renders in-app."

> Note on blast radius: `git log -L 73,73` on `dispatcher.ts` shows the unescaped jobId was introduced in `730eee5b` (BAL-289, PR #99) and has never been touched. Changing these jobIds changes dedup keys against retained completed jobs — a bounded one-time duplicate window, the same trade `toJobId` already accepted.

### 0.2 "Admin as observer into pipeline" is not a goal. It is already the shipped default.

The tracker's governing principle — "prefer read-into-pipeline over bespoke admin screens" — is already implemented in five lens resolvers:

| Resolver                          | File                                                           | Admin arm                                                                     |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Portfolio (`/projects`)           | `apps/web/src/lib/projects-inbox/resolve-portfolio-lens.ts:51` | platform staff **default** to `lens: 'admin'`                                 |
| Engagement (`/engagements/[id]`)  | `apps/web/src/lib/engagement/resolve-engagement-lens.ts:71-80` | `{ lens: 'admin', archetype: 'observer' }`, **precedence over ownership**     |
| Request (`/projects/[requestId]`) | `apps/web/src/lib/project-request/resolve-request-lens.ts:98`  | `admin` observer, "never denied" (`:167`)                                     |
| Request files                     | `apps/web/src/lib/request-files/load-request-files.ts:270`     | `{ lens: 'admin', files }`, `includeDeleted: scope.side === 'admin'` (`:177`) |
| Credit session money block        | `apps/api/src/services/credit-session/money-block.ts:79`       | `resolveAdminMoneyBlock`, capability-gated                                    |

Plus two admin-only list pages already inside the member shell: `/engagements` (`page.tsx:31`, `isPlatformAdmin → notFound()`) and `/promo-codes` (`page.tsx:33`).

**Implication for the five-area map:** the "Lookup" area is much cheaper than it looks. The drill-in machinery ships for engagements, project requests and request files. What is missing is the _entry points_ and the _entity types that have no lens yet_ — user, company, agency, meeting, session.

### 0.3 The margin invariant already leaks on lens alone.

§7 of the tracker says the admin serializer is the sole surface exposing margin and every admin action resolves a capability. That is true of `resolveAdminMoneyBlock` (`apps/api/src/routes/sessions/index.ts:262-268` re-reads the user from the DB and checks `MANAGE_PLATFORM_FEES`). It is **false** at `apps/web/src/lib/project-request/request-detail-view.ts:301`:

```ts
baloFeeBps: ctx.archetype === 'observer' ? request.baloFeeBps : null;
```

No capability check — the Balo fee renders on the lens alone. This is a D5 problem (see below), not a D2 one.

### 0.4 One security item worth its own ticket

`apps/web/src/app/admin-dev/_actions/delete-user.ts:33` runs a multi-phase cascade delete across `expert_profiles`, `company_members`, `agency_members` and meetings behind **only** `if (process.env.NODE_ENV === 'production')` — it never calls `getSession()` and never reads a role. `/admin-dev` is also registered in `PUBLIC_PATHS` (`apps/web/src/lib/auth/route-config.ts:16`), so the `/admin` middleware prefix does not cover it. Delete the surface or gate it.

---

## Part 1 — D1: the pending-actions primitive

### Direction

**Build `admin_alerts` as the state store. Keep Sentry/Axiom as the pager. Use the notification engine only as an optional ping on first sight.** Do not build the queue on `user_notifications`.

### Why not `user_notifications`

The negative case is decisive, and each half is checkable:

- **No unique index, no dedup.** `packages/db/src/schema/user-notifications.ts:22-26` — three indexes, all plain, none unique.
- **`deleted_at` has no writer.** The repository has six methods (`packages/db/src/repositories/user-notifications.ts:9,17,35,48,66,100`) and `readAt: sql\`NOW()\`` is the only mutation (`:69`, `:103`). Nothing can un-publish a notification when its condition clears.
- **Read state is per-user by construction.** `markAsRead(id, userId)` is scoped by userId, so "Dana handled it" is inexpressible without a second table anyway.
- **The only dedup available is a BullMQ jobId**, and `removeOnComplete: {count: 100}` (`apps/api/src/lib/queue.ts:6-9`) is an LRU **shared across all in-app traffic on the platform** — client bookings, messages, milestones, credit notices. It is a cache, not a constraint. Building a correctness guarantee on an eviction policy is the wrong foundation.

At the 4.9 shape (an alarm every minute) with 4 staff, that is 240 unresolvable rows per hour.

### Shape

```ts
// packages/db/src/schema/admin-alerts.ts
export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // open vocabulary, the audit_events posture
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(), // NOT NULL — see the arbiter note
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    occurrences: integer('occurrences').notNull().default(1),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    resolutionNote: text('resolution_note'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('admin_alert_open_idx')
      .on(t.kind, t.entityId)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.deletedAt} IS NULL`),
    index('admin_alert_queue_idx')
      .on(t.firstSeenAt)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.deletedAt} IS NULL`),
    index('admin_alert_entity_idx').on(t.entityType, t.entityId),
  ]
);
```

### The five details that decide whether this works

**1. The arbiter predicate must reference timestamp columns only.** Two independent reasons converge on the same rule:

- A partial-index `ON CONFLICT` arbiter whose predicate contains a parameterised enum literal raises **42P10 at plan time on the first statement**, while `tsc` and every mocked unit test stay green. The trap is documented in-repo at `packages/db/src/repositories/calendar.ts:241-249` and `reviews.ts:344-351`; `scheduled-notifications.ts:32` (`PENDING_ARBITER`) shows the inlining workaround.
- Independently, the schema states a house rule on the very tables you would be querying: _"the house rule (see `meeting-files.ts`, `transcripts.ts`, `action-items.ts`) is that an index predicate references COLUMNS ONLY, never an enum literal"_ — `packages/db/src/schema/meeting-recordings.ts:43-47`, repeated verbatim at `transcripts.ts:156`.

Keeping the predicate to `resolved_at IS NULL AND deleted_at IS NULL` satisfies both. The `targetWhere` upsert precedent is `packages/db/src/repositories/conversations.ts:1029-1037`.

**2. You already have this table for one domain — copy its posture.** `credit_receivables` (`packages/db/src/schema/credit-receivables.ts`) is exactly an alerts table for the money domain: one row per failed session, partial-unique on `session_id` (`:77`), status `open`/`cleared` (`:55`), and — the important part — _"The 'soft account hold' is DERIVED, not a column: a company is soft-held iff it has ANY open receivable"_ (`:24-27`). Same discipline: the alert row is the state; anything downstream derives.

**3. Two arms, one table, and no `source` discriminator column.** The split is by _sourcing_, and it is not even:

- **Sweep-discovered (~11 of ~14 kinds):** a stable row signature re-detectable every tick — 3.9's three monitor arms over `calendar_subscriptions`/`calendar_connections`, 3.11's three wedge shapes and 3.12's three documented signatures over `meeting_recordings`, 4.9's two reasons over `credit_wallets`. Plus, free: 3.6 (`transcripts.status='failed'`) and the meter sweep's settled-missing-credit pass, which the tracker misses entirely.
- **Event-driven (3 kinds), with no row to query at all:** 3.10 leaves nothing behind but a (never-created) BullMQ entry, and 4.8's refusal is _defined by the absence_ of a `credit_sessions` row.

Encode the close policy as **"kinds registered with a finder auto-close; kinds without a finder never do"** — a registry entry, not a column. A `source` column invites a row whose column and whose registration disagree.

**4. Snapshot the evidence into `detail`; do not store a pointer only.** `apps/api/src/jobs/auto-topup-reconcile-sweep.ts:44-51` warns that a later crossing re-arms the marker after `TOPUP_IN_FLIGHT_TTL_MS` (15 min), overwriting `pending_topup_triggering_entry_id` and nulling `pending_topup_payment_intent_id` — i.e. erasing the very evidence the alert points at. A pointer-only alert goes stale into uselessness on exactly the highest-value kind. (`scheduled_notifications.payload` is the in-repo precedent for a deliberately self-sufficient snapshot.)

**5. Order the queue by `first_seen_at`, never `updated_at`.** The per-tick `last_seen_at`/`updated_at` bump makes every open alert look freshly-arrived every minute.

**Corollary on nullability:** batch-filled and mass-failure alerts have no entity. Do **not** make `entity_id` nullable — `NULL != NULL` in a unique index silently defeats the arbiter (the trap is documented at `packages/db/src/schema/calendar.ts:132-136`). Give sweep-scoped alerts a per-sweep sentinel uuid.

### What must NOT change

The aggregated one-`log.error`-per-tick escalations stay exactly as they are. Two money sweeps independently converged on that design and wrote out the same reasoning:

> "ONE error per reason per TICK, never per row … per-row errors would turn one stuck wallet into 1,440 identical records a day (Pino → Axiom) while adding nothing a responder can act on."
> — `apps/api/src/jobs/auto-topup-reconcile-sweep.ts:175-197`, echoing `credit-session-meter-sweep.ts:426-433`

`raise()` is **additive**. The alert is the durable, resolvable, per-entity record; the log stays the pager. (Watch out: `credit-session-meter-sweep.ts:401` still carries a stale docblock saying "log.error PER ROW, ON PURPOSE" that the code at `:426-433` contradicts — both landed in the same commit `8245f21d`.)

### The counter-argument you should actually test

**"You are building a worse Sentry."** Sentry already ingests all of this via `Sentry.captureException` and Pino→Axiom, and already has grouping, first-seen/last-seen, occurrence counts, assignment and resolution — which is precisely this column list.

The counter to the counter:

- These are **business** conditions, not exceptions. "This company is owed money" and "this consultation was delivered unbilled" must be actioned by a non-engineer who will never have a Sentry seat.
- Sentry groups by stack trace, so the batched per-tick escalations become **one issue containing an array of 40 wallet ids** — un-triageable per entity, which is the exact deficiency the sweep docblock apologises for.
- Resolution in Balo can be an **action** linked to the entity (re-drive the ingest, re-submit the batch job, clear the marker), which Sentry structurally cannot offer.

**But that argument rests entirely on the operator/engineer split being real.** Validate it first. If Adeeb would in fact get a Sentry seat, the honest answer is to skip D1 and buy seats.

### Cost

New: `schema/admin-alerts.ts` (table #92), `repositories/admin-alerts.ts` + **mandatory** `admin-alerts.integration.test.ts` (genuinely load-bearing here — the 42P10 trap is invisible to `tsc` and to mocked unit tests), migration `0083_*` + journal + snapshot (run `prettier --write` on both meta JSON files), `apps/api/src/jobs/admin-alert-sweep.ts` + test + **a `vi.mock` entry in `worker.test.ts`** (a new jobs module imported by `startWorkers()` that isn't mocked there hangs CI), and the queue page with all four async states.

New partial indexes needed: 3 on `meeting_recordings`, 1 on `transcripts`. `calendar_subscriptions`/`calendar_connections` need none — `listExpiringBefore`, `listUnconfirmedBefore` and `listActiveConnectionsWithoutSubscription` already exist and already run daily.

~8 event-arm call sites, each already inside a `try/catch` that must never throw (`join-meeting.ts`'s contract is "may never fail a join"), so each `raise()` needs its own `.catch(() => undefined)`.

One new platform capability token (see D5).

---

## Part 2 — D2: config storage

### Direction

**Do not resurrect PR #180's singleton.** (Note: that PR is **CLOSED, unmerged** — `gh pr view 180` → `"state":"CLOSED"`. Nothing on `main` has a `platform_config` table; the branch `origin/yomi/bal-398-admin-minimum-consultation-length-platform-config` still has it, with migration `0053` against a main that is now at `0082`.)

Three shapes, chosen by data shape:

**1. Scalars → a keyed `platform_settings` table.**

```ts
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(), // ⇐ satisfies audit_events.entity_id (uuid NOT NULL)
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps, // no softDelete — a setting is replaced, never deleted
  },
  (t) => [uniqueIndex('platform_settings_key_idx').on(t.key)]
);
```

This is `fx_display_rates`' shape verbatim (`packages/db/src/schema/fx-display-rates.ts:16-38`): uuid PK + unique natural key as the upsert target. Twenty knobs = twenty rows, **zero further migrations**. Typing lives in a pure registry in `@balo/shared` (no `@balo/db` import), and **the existing constants become the registry defaults**, so nothing breaks the day the table lands.

**2. Per-scope overrides stay where they already are.** Main already has three of the four the tracker lists:

| Knob                 | Where it already lives                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Overdraft ceiling    | `credit_wallets.overdraft_ceiling_minor`, nullable, read `?? DEFAULT_OVERDRAFT_CEILING_MINOR` (`credit-sessions.ts:975`) |
| Per-project fee      | `project_requests.balo_fee_bps` + the shipped, capability-gated, **audited** `overrideBaloFee` action                    |
| Auto-top-up defaults | already client-configurable on the wallet                                                                                |

The pattern is **nullable column on the owning row + `?? platformSettings.get(key)`**. The only change is that the fallback moves from a code constant to a settings read. Do **not** invent a generic `(scope_type, scope_id, key, value)` override table — it would duplicate columns that already hold production data.

**3. Ordered lists get their own table.** `featured_experts (id, expert_profile_id FK, sort_order integer NOT NULL, is_active, …timestamps, …softDelete)` — following `industries.ts:14` / `project_tags.ts:26,50` / `experts.ts:318`. A "min 3" rule is a service invariant, not a CHECK. Never a JSON array in a settings row: reordering, FK integrity and soft-delete all become hand-rolled.

### The audit question — answer YES, and note why the PR didn't

PR #180's own schema docblock admits it writes no `audit_events` row and calls that "known, pre-existing drift" from ADR-1030. Part of the reason is structural: `audit_events.entity_id` is a **uuid NOT NULL** (`packages/db/src/schema/audit-events.ts:39`), and the singleton's PK is the integer `1`. (Strictly it is "ugly and unenforceable" rather than impossible — `entity_id` has no FK, so a sentinel uuid would technically work — but a uuid-PK settings row makes the audit row natural instead of contrived.)

**The precedent to follow is `updateBaloFeeBps`, not promo-codes.** `packages/db/src/repositories/project-requests.ts:409-434` opens `db.transaction` and calls `auditEventsRepository.record(...)` with `action: 'project_request.balo_fee_overridden'` in the same transaction, driven from a `hasPlatformCapability`-gated Server Action (`override-balo-fee.ts:50,66`). By contrast the three promo-code admin actions write **only** `log.info` (`create-promo-code.ts:70`) and record just `created_by`. Bring the promo-code actions up to the audited pattern in the same ADR — they are the drift, not the rule.

### The crux that determines migration order

Not every constant can move. Of the platform constants the tracker flags, roughly **10 are read from more than one app**, and 2–3 are compiled into the **browser bundle** (`SLOT_DURATION_LADDER` via `filters.ts`, which has 13 `'use client'` importers; `DEFAULT_BALO_FEE_BPS` via `billing-line.tsx` and `admin-fee-override-panel.tsx`). A constant read in `packages/shared` by both apps cannot become an async DB read without prop plumbing.

So sequence it:

- **First (cheap, api-only):** the three rate limits in `apps/api/src/routes/meetings/guards.ts`, `MIN_IDLE_TIMEOUT_SECONDS`, the transcription `language: 'en'`, `TOPUP_RECONCILE_AFTER_MS`.
- **Later (needs plumbing):** `MIN_MEETING_MINUTES`, `DEFAULT_BALO_FEE_BPS`.
- **Blocked:** the **billing floor** specifically needs the per-session snapshot on `credit_sessions` first (tracker §8) — otherwise an in-flight session sees a knob change mid-call. Note `credit_sessions.billing_floor_minutes` already exists and is **nullable** (`credit-sessions.ts:197`), unlike the other snapshot columns.

Also worth knowing before anyone cherry-picks the branch: main **already** has an env-var config for the exact BAL-398 knob — `apps/api/src/services/availability/resolve-and-cache.ts:95` reads `process.env.MIN_CONSULTATION_MINUTES ?? '15'` — and the branch deletes it. The branch also adds a **third** name for the number 15 (`BILLING_FLOOR_MINUTES`, `DEFAULT_MIN_CONSULTATION_MINUTES`).

### What you give up

Per-key CHECKs. PR #180 got two real ones (`>= 15`, and `<= 240` added in a second fix commit precisely because an unbounded value could null out availability platform-wide). With `value jsonb` there is no per-key CHECK.

Mitigate: the repository is the **only** writer and validates against the registry before insert; add a coarse `CHECK (jsonb_typeof(value) IN ('number','string','boolean','object'))`; pin every key's schema in a table-driven test. That is genuinely weaker than a real CHECK. **If Balo ends up with ≤6 knobs and no ordered lists, the singleton wins** — the recommendation flips at ~20 rows including a list and per-scope defaults.

---

## Part 3 — D3: does an admin read of party data write an access record?

### Direction

**Reads write nothing to `audit_events`.** Where a durable record is genuinely required, make the disclosure an explicit **act** rather than instrumenting the read.

### The hard blocker on the naive version

`apps/web/src/invariants/_read-only-actions.ts` defines `READ_ONLY_ALLOWLIST` — the single list of Server Actions permitted to authenticate with a bare `requireUser()` — policed from two directions by `onboarding-mutation-gate.test.ts` and `conversation-access-read-only.test.ts`. Its docblock records exactly why:

> "⚠⚠ EXTRACTED BECAUSE A HAND-MAINTAINED SECOND COPY ALREADY FAILED. BAL-424 made `resolveConversationAccess` get-or-CREATE, which turned every allowlisted caller into a transitive writer behind a bare `requireUser()`. The follow-up invariant listed its subjects by hand — and listed only two of the THREE affected actions, so `get-proposal-document-download.ts` kept the writing variant while both tests stayed green."

Making `get-meeting-file-download.ts` or `list-meeting-files.ts` write an audit row collides head-on with a shipped invariant that exists because this exact mistake was already made once.

### The rule to put in the ADR

> **`audit_events` records ACCESS-BOUNDARY DECISIONS AND STATE CHANGES, never ACCESS ITSELF.** A write earns a row iff it (1) changes a party's authority or capability, (2) moves or accrues money, or (3) writes a party-visible domain row. A read does none of the three.
>
> **Corollary — the axis a reader was authorized on does not change the rule.** A `platformRoleHasCapability` read and a `hasCapability` read record identically: neither records. This is what stops "admin reads are special" from becoming a per-ticket argument.

Observability for reads is Pino/Axiom + PostHog — the posture ADR-1030 already takes for machine telemetry (`packages/db/src/schema/meeting-presence.ts:80-81`).

Empirically this is where the codebase already is: all 36 production `auditEventsRepository.record(` call sites record a state change, and the ~66 distinct `action` labels are all mutation verbs. `VIEW_ANY_REQUEST_FILE` — the one shipped platform-capability-gated **read** — writes nothing; its gate `authorizeRequestFileScope` advertises that it performs no writes.

### Where a durable record IS required: make it an act, not a read

For recording playback (3.11) and transcript text (3.6/3.12) — the two most sensitive artifacts — build the admin arm as its **own** Server Action (`get-meeting-recording-playback-as-admin.ts`, `reveal-transcript-as-admin.ts`), following the shipped `request-proposal-as-admin.ts:138` shape: gated on a new platform token, authenticated with `requireOnboardedUser()`, and **not** on `READ_ONLY_ALLOWLIST`.

Then the row records _an act the admin took_ ("revealed"), not a read — which keeps the rule intact and produces the auditable row anyway. Namespace it `platform_disclosure.*` with `entityType='transcript'|'meeting_recording'`. Because `action` and `entity_type` are open TEXT (`audit-events.ts:33-37`), **this needs no migration**.

Two hard constraints:

- **Server Actions and route handlers only — never a `page.tsx` render loader.** Next prefetches `<Link>` on hover (`join-control.tsx:481-485` calls `prefetch={false}` "LOAD-BEARING"), and `loadRecap` is called twice per request, deduped only by React `cache()`. A write on render fires on hover.
- **Accept the honest grain: the LIST records nothing; the DOWNLOAD/REVEAL does.** The list discloses names and sizes; the presign discloses the bytes.

Cost is small: `transcriptsRepository.findById` and `findByCaptureId` already return the full row including `canonical`, so an admin transcript surface is a gate plus a call site, not a new repository method.

### Two things to decide with eyes open

**This decision is retroactive in scope.** Four cross-tenant admin reads of party data **already ship on main**, all gated on a bare `isPlatformAdmin`, none capability-gated, none recording anything:

- `/engagements` oversight list — `engagements/page.tsx:31` → `loadEngagementsOversight()` → `listAllWithProgress` (platform-wide)
- `/projects` admin lens — `portfolio-view.ts:459-469` `loadAdminPortfolio`, docblock "Returns platform-wide data", `listAll()` + `listPortfolio({ platform: true })`
- `/engagements/[id]` — the full delivery workspace for any engagement
- Request files with `includeDeleted` for the admin side

There is **no access-log table anywhere in the 91-table schema.**

**Reopen this if Balo signs an enterprise DPA promising a customer-visible access log.** "We logged it to Axiom" is a weaker answer than an append-only row with a restricted actor FK, and Axiom retention is finite while `audit_events` has no `deleted_at` and no expiry. The mitigation is that step (3) makes reopening cheap — the `platform_disclosure.*` namespace already exists for the two highest-sensitivity artifacts, and extending it to files and conversations is additive and migration-free.

---

## Part 4 — D4: admin mutations, re-drive, impersonation

### 4.1 Re-drive cannot be a web Server Action

`rg 'bullmq|ioredis|REDIS_URL' apps/web/` returns **0 matches across 2139 files**. The admin dashboard is `apps/web`; the queues are `apps/api` on Railway. So a re-drive must be an `apps/api` route.

**The full path already ships** — this is not new ground:

- `apps/api/src/lib/require-auth.ts` verifies a WorkOS Bearer JWT against the WorkOS JWKS and resolves `sub` → Balo user id.
- `apps/api/src/routes/sessions/index.ts:251-268` (`GET /admin/sessions/:id/money-block`) then does a **live** `usersRepository.findById(userId)` + `platformRoleHasCapability(...)` → 403. It deliberately does **not** trust a cookie-carried role.
- `POST /meetings/:meetingId/cancel` arm 3 (BAL-410) is the same pattern for a mutation.
- `apps/web` has **two** Bearer-forwarding helpers: `postBaloApiJson` (`lib/api/balo-api-client.ts:85`, four shipped consumers including `cancel-api-client.ts:108`) and `callSessionApi` (`lib/credit/api-client.ts:281`, takes `GET | POST`).

### 4.2 The four re-drive cases are NOT one mutator

| Case                          | What it actually needs                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recording retry** (BAL-484) | A **new** repository CAS. `markFailed` is terminal and no method writes `status:'source_ready'` outside `markSourceReady`. Reset `status`, `failed_stage`, `failure_reason`, **and `mux_asset_id`** (the ingest job's first gate treats a stamped asset id as "already ingested"; `markIngesting`'s CAS requires it NULL). Precondition `source_deleted_at IS NULL`. |
| **Transcript re-submit**      | **No column reset at all** for the pre-submission-failure case. And the mutator must be _structurally incapable_ of writing any `transcript_job_*` column — a row carrying `finished_at` must never be reset, because the new job's `job-finished` webhook CASes to no-op and no ingest fires.                                                                       |
| **Auto-top-up marker clear**  | A pure DB clear; **no queue involved** — the per-minute cron re-evaluates. Note `clearPendingTopup` (`credit-wallets.ts:218-226`) has **no `deleted_at IS NULL`** term on either branch, unlike the meeting-recordings CAS family, so an admin button would clear the marker on a soft-deleted wallet.                                                               |
| **Calendar-amend re-enqueue** | Currently un-enqueueable at all — see §0.1(a). Fix the jobId first.                                                                                                                                                                                                                                                                                                  |

### 4.3 The BullMQ constraint, and the answer the repo has already chosen

A same-id re-add is a silent no-op while the retained failed job exists (`removeOnComplete: {count:100}`, `removeOnFail: {count:500}` — `apps/api/src/lib/queue.ts:6-9`).

The codebase has already rejected both obvious workarounds: **`job.retry()` has zero occurrences repo-wide**, and remove-then-add was _removed in a fix round_ because `remove()` cannot beat an ACTIVE job. What it uses instead is a **dedupe token appended to the jobId**.

So: `<originalJobId>--redrive-<auditId>`. That id is disjoint from the retained failed job (no `remove()` needed), self-deduped under a double-click (same audit row → same jobId), and it ties the queue write to the audit row exactly as `meeting-calendar-amend` already ties its jobId to the reschedule audit id.

### 4.4 Recommended route shape

```
POST /admin/redrive/:kind/:id       kind ∈ 'recording-ingest' | 'transcript-submit' | 'calendar-amend'
preHandler: [requireAuth]
  const user = await usersRepository.findById(request.userId);       // LIVE — the money-block pattern
  platformRoleHasCapability(user.platformRole, PLATFORM_CAPABILITIES.REDRIVE_JOB) || 403

  1. db.transaction(async (tx) => {
       const reset = await <repo>.<reopen>(…, tx);   // may be a no-op for transcript-submit
       if (!reset) return null;                      // CAS refused → 409, nothing enqueued
       const audit = await auditEventsRepository.record({
         actorUserId: user.id, action: `admin.redrive.${kind}`,
         entityType: kind, entityId: id,
         metadata: { previousStatus, previousFailedStage, previousFailureReason, orphanedMuxAssetId },
       }, tx);
       return audit.id;
     });
  2. AFTER COMMIT: enqueue with jobId `<original-jobId>--redrive-<auditId>`
```

**Counter-argument to weigh:** this puts the audit row in `apps/api` while promo-codes and `override-balo-fee` audit in `apps/web` — splitting the admin mutation pattern across two apps and two auth mechanisms, and the web action must handle a 409/503 without knowing whether the reset committed. The cheaper alternative is a `requireInternalAuth` "dumb enqueue" endpoint with the web owning authz + reset + audit in one Server Action transaction. Reject it because the API would then enqueue on an unverifiable actor claim, and a leaked `INTERNAL_API_SECRET` becomes a queue-injection primitive with no identity trail. But it is a defensible call and it is cheaper.

Note the attribution+audit-in-one-transaction pattern **does** have a shipped precedent on the platform axis: `override-balo-fee.ts:50` → `updateBaloFeeBps` → `db.transaction` + `auditEventsRepository.record` (`project-requests.ts:409-434`).

### 4.5 Impersonation — don't build it for v1, but fix the half-built seam

`SessionUser.isImpersonating?: boolean` **already exists** (`apps/web/src/lib/auth/session.ts:25`) with a docblock citing the workos-auth skill. It has exactly one consumer chain: `expert-checklist.ts:78` → `lib/expert/searchability.ts` → `packages/db/src/repositories/expert-searchability.ts:168`, which writes `actorImpersonating` into `audit_events.metadata`.

**Nothing sets it.** `grep startImpersonation|stopImpersonation` across `apps` and `packages` returns empty. Worse, the repository docblock asserts something the plumbing makes false:

> `expert-searchability.ts:166-169` — "Set when `actorUserId` is a staff member's id captured while impersonating"

…but `expert-checklist.ts:86` passes `actorUserId: user.id`, which under the skill's design (`.claude/skills/workos-auth/references/webhooks-sessions.md:221-236`) is the **target**, not the admin. A live-looking flag with no writer, plus a comment a reader could act on, is how a future gate fails open. Either delete both or annotate them.

**If it is built later, it must invert the skill's design.** Keep the **admin** in `session.user.id` and put the target in a new field the drift check ignores. Otherwise `apps/web/src/app/api/auth/session-sync/route.ts:50` unconditionally overwrites `platformRole` from the DB row of `session.user.id` — so a swapped-identity session either loses every admin power on the next request, or (worse, if the target happens to be staff) keeps them. Then: `audit_events.actorUserId` = the **admin**, with `{ actorImpersonating: true, impersonatedUserId }` in metadata; and refuse every money-path and identity-path mutation outright.

**Representations cannot substitute.** `representations.on_behalf_of_company_id` is NOT NULL with no user-subject column, and `REPRESENTABLE_CAPABILITIES` is exactly two tokens. It is an act-on-behalf-of-an-**org** grant, not an act-as-a-**person** grant.

---

## Part 5 — D5: platform staff roles

### Direction

**Keep `platform_role` at three enum values. Add named bundles keyed on the enum, plus one nullable `users.platform_capabilities` jsonb override column (NULL = "use my role's bundle").**

```ts
// packages/db/src/schema/users.ts — catalog-only ADD COLUMN, no rewrite, no backfill
platformCapabilities: jsonb('platform_capabilities').$type<PlatformCapability[]>();
```

```ts
// packages/shared/src/authz/platform.ts — stays PURE and SYNC, no I/O
export function resolvePlatformCapabilities(
  role: string,
  override?: readonly PlatformCapability[] | null
): readonly PlatformCapability[] {
  const bundle = PLATFORM_ROLE_CAPABILITIES[role] ?? [];
  if (override == null) return bundle;
  return override.filter((c) => ALL_PLATFORM_CAPABILITIES.includes(c)); // read-path re-filter
}
```

**Override, not additive.** Additive cannot express Luke ("everything except `CANCEL_ANY_MEETING`") without inventing a role per person — which is the enum option wearing a hat.

Mapping the four humans: Yomi = `super_admin`, override NULL. MJ = `admin` + `[MANAGE_PLATFORM_FEES, MANAGE_PROMO_CODES, MANAGE_PLATFORM_CONFIG]`. Adeeb = `admin` + support tokens, **no** `MANAGE_PLATFORM_FEES`. Luke = `admin` + all tokens minus `CANCEL_ANY_MEETING`.

### Why not more enum values

Everything Adeeb needs to **see** already works on `admin` and breaks the moment the enum widens: the five lens reads, the two `isPlatformAdmin → notFound()` view gates, and — **silently, with no failing test** — the `admin_users` notification fan-out at `apps/api/src/notifications/engine/resolver.ts:148`:

```ts
data.adminUserIds = await usersRepository.findIdsByPlatformRoles(['admin', 'super_admin']);
```

`findIdsByPlatformRoles(roles: PlatformRole[])` accepts the widened union without a type error, so a new `support` role would just stop receiving admin notifications with nothing failing. Keeping the enum at three makes the visibility half of D5 cost **zero files**.

### Why not a grant table yet

Both `apps/api` capability gates already `await usersRepository.findById(userId)`, so a column on `users` arrives with **no extra query and no async change**. A separate table adds a round-trip at every gate, a repository, a mandatory integration test, and a grant/revoke/expire lifecycle — for four people who change roughly never. Escalate when staff grants need issuer attribution and expiry; `representations` is then the template.

### Cookie budget (measured)

Baseline sealed `balo_session` is 2859 bytes on a fully-populated session; `SAFE_BUDGET_BYTES = 3500`; hard browser limit 4096 (`apps/web/src/lib/auth/session-cookie-size.test.ts:41,47,111`). Four capability strings cost **+150 bytes** (→ 3009); twelve cost +363; the 3500 guard breaks at 17 tokens. Comfortable. If the vocabulary is ever expected to pass ~15, drop it from the cookie and make `hasPlatformCapability` async over a `cache()`d user read — 5 `await` edits.

### The non-optional prerequisite — this is the real work item, not the column

Platform-role authorization on main is not one axis. Only 8 call sites go through `platformRoleHasCapability`. **Seven mutating Server Actions are gated by `requireAdmin()`** — a raw `admin|super_admin` set test — all under `apps/web/src/app/(dashboard)/projects/[requestId]/_actions/`:

`invite-experts.ts:104` · `approve-kickoff.ts:174` · `remind-client-billing.ts:121` · `request-proposal-as-admin.ts:144` · `request-exploratory-meeting.ts:37` · `remove-invited-expert.ts:32` · `search-experts-for-invite.ts:39` (this last one is read-only)

Plus the `baloFeeBps` lens leak at `request-detail-view.ts:301` (§0.3), and two literal comparisons at `middleware.ts:111` and `admin-dev/_actions/approve-expert.ts:30`.

**Until those carry capability tokens, the split is theatre** — Adeeb-as-support would still be able to invite experts and approve kickoffs. Both of the first two carry `TODO(BAL-314): replace the platformRole gate with canActOnBehalf(admin, request)` comments already.

### Three mitigations that should be hard ticket requirements

The honest objection to a jsonb override: it breaks the single most valuable property the platform axis has — `platform.ts`'s claim to be "the SINGLE place a platform-staff `platformRole` string is interpreted into capabilities." After this change the answer depends on a per-user blob no test, invariant or UI can see. A mis-typed token silently denies; a stale row silently grants.

1. **The read-path allowlist filter is non-negotiable** (the `representations.ts:130-137` pattern, shown above).
2. **Every write to `platform_capabilities` records an `audit_events` row in the same transaction** — `entityType: 'user'`, `action: 'user.platform_capabilities_set'`, metadata = before/after arrays.
3. **A table-driven test pinning all four humans' resolved sets**, so "Adeeb must not hold `MANAGE_PLATFORM_FEES`" is an executable assertion rather than a row in prod.

### One structural note

`super_admin` is currently identical to `admin` — `PLATFORM_STAFF_BUNDLE` is a **single shared array object reference** assigned to both keys (`platform.ts:69-72`), which is why `expect(PLATFORM_ROLE_CAPABILITIES.admin).toEqual(PLATFORM_ROLE_CAPABILITIES.super_admin)` (`platform.test.ts:87`) passes trivially. Splitting them is a genuine structural change, not a config edit. Adding a 5th token to the bundle, however, breaks **no** existing test — neither `platform.test.ts` file enumerates the bundle.

---

## Part 6 — D6: where admin lives in the shell

### Reject Option A (admin as a third workspace type) — it is blocked, not expensive

- `WorkspaceSessionProjection` requires a **non-optional** `companyId` + `companyRole`.
- The stored choice is backed by the `user_mode` pgEnum `['client','expert']` (`enums.ts:3`) — there is nowhere to persist a third type.
- `checkSessionDrift` compares `derived.activeWorkspace.key` on every render, so a non-persistable active workspace returns `'sync-needed'` forever — the unbounded layout→sync→layout lockout `session-sync.ts:53-58` exists to prevent.
- Making it work means fabricating a company for admin, which is precisely the fabrication BAL-494's ruling R1 deleted.

Conceptually too: a Balo admin never stops being a member of their personal company; they _gain a cross-tenant view_. That is a capability, not a "what am I acting as" choice in the ADR-1053 sense.

### Take Option B in its cheap form

**`/admin/*` URLs that stay INSIDE the `(dashboard)` route group** — exactly what the closed BAL-398 branch already built at `app/(dashboard)/admin/config/`. That is the only shape that gets both the currently-dead `/admin` middleware prefix **and** the shell for free.

Copy `(dashboard)/promo-codes/` wholesale: it already ships `page.tsx`, `error.tsx`, `loading.tsx`, `not-found.tsx`, `page.test.tsx` and three Server Actions each gated with `hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES)`, with an explicit docblock at `create-promo-code.ts:37` saying to use the capability and **NOT** `requireAdmin()`.

### Four things to get right

**1. Convert the middleware gate to the capability axis.** `apps/web/src/middleware.ts:109-114` currently does:

```ts
const role = user.platformRole ?? 'user';
if (role !== 'admin' && role !== 'super_admin') { redirect '/dashboard' }
```

Convert to `platformRoleHasCapability`. Legal in Edge — `packages/shared/src/authz/platform.ts` is pure and dependency-free, and `PLATFORM_ROLE_CAPABILITIES` is typed `Record<string, …>` so it accepts a bare string and returns `false` for unknowns. This makes the dead `/admin` prefix the first line of defence for the whole tree and fixes an existing ADR-1029 violation as a side effect. (The page-level `isPlatformAdmin → notFound()` stays as documented defence-in-depth — the BAL-398 page docblock describes the two as layered, not redundant.)

**2. `resolveNavCapabilities` cannot be appended to.** `apps/web/src/lib/navigation/nav-context.ts:55-70` has four return points, and a staff user hits an early `[]` twice:

```ts
if (!user) return [];
if (!roleHasCapability(user.companyRole, CAPABILITIES.MANAGE_MEMBERS)) return []; // ← plain member ⇒ []
const company = await readCompanyForRequest(user.companyId);
if (company === undefined || company.isPersonal) return []; // ← personal company ⇒ []
return [CAPABILITIES.MANAGE_MEMBERS];
```

Every Balo user is provisioned into a personal company (`users.ts:190`, `isPersonal: true`), so a staff member in their default workspace gets `[]` and the admin entry never renders. **Restructure all four returns; do not append.** `NavCapability` (`nav-registry.ts:49`) is also a single literal type with an explicit warning against casual widening — widening it is deliberate, and one new `NAV_ITEM_KEYS` entry in `packages/analytics` must land in the same PR or typecheck breaks.

**3. Do NOT move `/engagements`.** Only the **list** page is admin-gated. `/engagements/[id]` is a three-lens **member** route serving client, expert and admin (`resolveEngagementLens`), and **43 of the tree's 60 files live under `[id]`**. Moving it would put the `/admin` middleware redirect in front of every client and expert opening their own engagement — a functional break, not churn. If you move anything, move `/promo-codes` (26 files) and the engagements _list_ (17 files). Moving nothing at first and just adding the `/admin` home is also defensible.

**4. `ENTITY_PARENTS.engagements` is a live defect regardless of D6.** `nav-registry.ts:392` gives `/engagements/[id]` a parent crumb linking to `/engagements` — which is admin-only, so a client or expert on their own engagement gets a breadcrumb to a 404. Note `resolveBreadcrumbTrail` is a **pure function of pathname with no actor argument** (`:432`), pinned by ~10 assertions, so a lens-aware crumb is a signature change. The cheap fix is to delete the row.

### Cost comparison

| Option                                    | Cost                                                                                    | Verdict                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| A — third workspace type                  | Blocked (see above)                                                                     | Reject                      |
| B cheap — `/admin/*` inside `(dashboard)` | ~5 edited files; moves optional and deferrable                                          | **Recommended**             |
| B full — top-level `(admin)` route group  | Duplicates providers/theme/session/error boundaries across 6 existing route groups      | Not worth it                |
| C — status quo                            | 0 files, but `/admin` prefix stays dead and per-page `notFound()` remains the only gate | Strictly worse than B-cheap |

---

## Part 7 — Sequencing

I would make one change to "decision 1 first, decision 6 second": **swap them.** D1's deliverable is a page, a page needs a home, and D6-cheap is ~5 files against D1's ~15.

| #     | Work                                                                                                                                    | Why here                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **0** | Fix the two jobIds (~1 line each). Delete or gate `/admin-dev`.                                                                         | Both live. One is the direct cause of "3.9 has no in-app surface", so D1's premise is partly self-inflicted. |
| **1** | **D6 cheap** — `/admin` home + middleware capability conversion + nav restructure.                                                      | Makes the dead prefix live and gives every later surface a home. Cheapest item on the list.                  |
| **2** | **D1** — `admin_alerts` table + sweep registry + one queue page.                                                                        | Closes open questions in ~10 tracker items. Validate the operator/engineer split first.                      |
| **3** | **D5's prerequisite** — the 7 `requireAdmin()` actions and the `baloFeeBps` lens leak onto capability tokens. Then the override column. | Without this the staff split is theatre.                                                                     |
| **4** | **D2 / D3 / D4** per-area as each surface is designed.                                                                                  | D4's re-drive route is the natural first consumer of D1's action column.                                     |

### On the five-area map

It holds. Three adjustments:

- **Lookup is cheaper than it looks** — the lens machinery ships for engagements, project requests and request files. What's missing is entry points and the entity types with no lens yet (user, company, agency, meeting, session).
- **Queues partly exists** — `AdminDash` (`app/(dashboard)/projects/_components/admin-dash.tsx`) is the projects triage surface, and it hand-links to `/promo-codes` and `/engagements` today.
- **The Home/Health split is the right answer** to the recurring "own view or the 6.1 queue?" question: a Health row that needs a human raises an alert; Health is where you see the row's full state and act. One primitive, two lenses.

---

## Appendix — items to add to the tracker

| Item                                  | Detail                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **3.10 correction**                   | The amend never enqueues (one-colon jobId). Not "exhausts 5 attempts" — no attempts, no failed-set entry.                    |
| **3.9 correction**                    | The `calendar.subscription_lapse` in-app fan-out throws at `channelQueue.add`. Has never delivered.                          |
| **New — dispatcher jobId**            | 5 `admin_users` events dead at `dispatcher.ts:73`. Second unfixed instance of the `toJobId` class.                           |
| **New — `/admin-dev` cascade delete** | No auth gate at all; `/admin-dev` is in `PUBLIC_PATHS`.                                                                      |
| **New — margin on lens alone**        | `request-detail-view.ts:301` renders `baloFeeBps` with no capability check, contradicting §7.                                |
| **New — `clearPendingTopup`**         | Missing `deleted_at IS NULL`; an admin "unblock" button would clear the marker on a soft-deleted wallet.                     |
| **New — breadcrumb 404**              | `ENTITY_PARENTS.engagements` links members to an admin-only list.                                                            |
| **5.1 status correction**             | PR #180 is **CLOSED**, not "in review". Branch migration is `0053`; main is at `0082`.                                       |
| **Third money alarm**                 | The meter sweep's settled-with-no-ledger-credit pass ("Expected 0 forever") is a 4th-section alarm the tracker doesn't list. |
| **Stale docblock**                    | `credit-session-meter-sweep.ts:401` says "log.error PER ROW, ON PURPOSE"; `:426-433` does the opposite. Same commit.         |
