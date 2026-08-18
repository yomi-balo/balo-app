---
name: apiroc
description: >
  Integration patterns for the Apiroc Unified Calendar API (formerly branded OneCal) within
  Balo — the calendar vendor chosen in ADR-1021. Use this skill whenever implementing or
  modifying any calendar-related feature: expert calendar connection (Google/Microsoft
  OAuth), listing calendars, subscribing to change webhooks to trigger an availability
  rebuild, fetching free/busy for the expert profile slot picker, writing or deleting
  consultation events, tagging events with baloBookingId, and applying the weekly-schedule
  availability rules (BAL-195) in Balo's own slot calculator. Also covers the
  endUserAccountId pointer model, error-driven reconnect detection, subscription
  lifecycle, and the SDK's error/logging defects. Trigger on any mention of Apiroc,
  OneCal, unified calendar, calendar sync, OAuth calendar, iCloud calendar, availability,
  free/busy, calendar webhook / subscription, syncToken, calendar events, or availability
  rules.
---

# Apiroc (formerly OneCal) Unified Calendar Integration Skill

> **Vendor:** Apiroc Unified Calendar API (ADR-1021). The product was branded **OneCal** and
> is mid-rename — the dashboard nav still says OneCal, the docs say Apiroc. Don't hard-code a
> single docs/dashboard domain.
>
> **SDK:** `@apiroc/unified-calendar-api-node-sdk` — this document is verified against
> **v2.0.1**. Default API base **`https://api.apiroc.com`**. Docs at `docs.apiroc.com`;
> dashboard at `app.onecalunified.com` (at time of writing).
>
> ⚠ **`@onecal/unified-calendar-api-node-sdk` is DEPRECATED on npm** — _"Package no longer
> supported"_, last version `1.3.1`. Do not install it. It was republished under the
> `@apiroc` scope (same maintainer, same GitHub repo `OneCal/unified-calendar-api-node-sdk`).
> An earlier revision of this skill documented v1.2.2 and `https://api.onecalunified.com`;
> both are stale. (Both hosts still answer, but write the new one.)
>
> **Supersedes the Cronofy skill**, deleted in PR #197. ⚠ The Cronofy _skill_ is gone; the
> Cronofy _code_ is still live (`apps/api/src/lib/cronofy.ts`, `apps/api/src/services/cronofy/`)
> until BAL-396 removes it. Absence of the skill is not absence of the integration.

## How to read this document

This skill was **rewritten against captured runtime behaviour** (BAL-458). Its first version
was written from vendor docs and SDK type definitions, and **four of its six standing
hypotheses turned out to be false** — see the [Hypothesis ledger](#hypothesis-ledger) at the
bottom for what changed and why.

Every non-obvious claim carries an evidence tag:

| Tag        | Means                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| **[live]** | Observed against the real API; response saved under the spike's `captures/`     |
| **[stat]** | Read out of the published SDK bundle — ground truth for SDK, not API, behaviour |
| **[docs]** | Vendor documentation only — **not** verified against a running system           |

**Untagged prose is a Balo design rule, not a vendor fact.** If you are about to rely on a
`[docs]` claim in code that can fail silently, verify it first.

**Evidence lives in the BAL-393 spike** (`spikes/apiroc-probe/FINDINGS.md`, PR #211, branch
`yomi/bal-393-spike-validate-apiroc-onecal-calendar-api-runtime-behaviour` — **not merged to
`main`**, deliberately: the harness sits outside the pnpm workspace). Section refs below
(§P3, §M2, "Unknown 2", …) point into that document.

---

## Balo-Specific Context

Apiroc is Balo's calendar infrastructure. It handles:

- **Connection** — expert connects Google / Microsoft via Apiroc hosted OAuth (BYOC: the
  consent screen should show Balo's branding — BAL-394 must confirm; on shared sandbox
  credentials it reads _"Apiroc wants access to your Google Account"_ **[live]**).
- **Calendar listing** — surfaces all calendars (Work, Personal, etc.) for the
  conflict-check toggle UI.
- **Change webhooks (Google/Microsoft)** — Apiroc POSTs to Balo's webhook when an expert's
  calendar changes; Balo enqueues a **whole-window availability rebuild** — the webhook is a
  bare trigger. **No delta read, on any provider** (BAL-447 / ADR-1021 amendment 2026-08-15).
- **Availability cache update** — on webhook, Balo recomputes and stores
  `earliest_available_at` per expert (one DB row, not a full event mirror).
- **Free/busy fetch** — when a client views an expert's profile, Balo calls `freeBusy.get`
  for the forward window to populate the slot picker.
- **Event write / delete** — consultation booked → create event on the expert's target
  calendar, tagged with `privateExtendedProperties.baloBookingId`; cancelled → delete by the
  **vendor-returned** event id.
- **Availability rules (BAL-195)** — the expert's weekly schedule is stored in **Balo's DB**
  and applied by **Balo's slot calculator** over Apiroc free/busy. Apiroc has **no
  server-side availability-rule primitive** (unlike the prior Cronofy design — see "Deltas
  from the Cronofy design" below).

**Stack:** TypeScript, Fastify (backend on Railway), Drizzle ORM, BullMQ + Redis.
**SDK:** `pnpm add @apiroc/unified-calendar-api-node-sdk`

---

## Deltas from the Cronofy design (read first if porting old code)

1. **Vendor holds the tokens.** We store only an `endUserAccountId` pointer + a credential
   status. No encrypted `access_token` / `refresh_token` columns. Apiroc refreshes provider
   tokens itself. ⚠ But `endUserAccounts.getCredentials(id)` **does** return raw provider
   `accessToken` / `refreshToken` **[stat]** — the "we never hold tokens" posture is a choice
   we keep making, not something the API enforces. Prefer `endUserAccounts.get(id)` (status
   only) when the status is all you need; never log or persist a credential object.
2. **Reconnect is detected from a FAILED DATA CALL, not from a status field.**
   `EndUserAccountCredentialStatus` (`ACTIVE | EXPIRED | REVOKED`) is a **lagging** record —
   it does not move until a data call has already failed. See
   [Credential expiry & reconnect detection](#credential-expiry--reconnect-detection).
   _(This inverts the rule the first version of this skill gave.)_
3. **No server-side Availability Rules.** BAL-195 weekly schedule is Balo-owned data applied
   in our slot calculator. `freeBusy.get` returns raw busy slots only.
4. **One End User Account PER PROVIDER**, not one connection per expert. `calendar_connections`
   is unique on `(expertId, provider)`; free/busy is merged across an expert's accounts;
   disconnect is per-provider (BAL-467 §1).
5. **No incremental sync — `syncToken` is not used.** Microsoft never returns one at all
   (§M2, verified paginated to exhaustion at `pageSize=1`); Google returns one only on the
   FINAL page (§P3); and availability is sourced from `freeBusy.get`, which has no delta mode
   on either provider. Every webhook triggers a whole-window re-read instead. (No
   Cronofy-style change channels either.) See BAL-447 / ADR-1021 amendment 2026-08-15.
6. **Custom event tagging** via `privateExtendedProperties` / `publicExtendedProperties`
   (`Record<string,string>`), queryable via `metadataFilters`. ⚠ On Microsoft the tag is
   **write-and-query-only on create/update — those return `{}`** (§M3). ⚠ Nuance corrected
   2026-08-18: a `metadataFilters` **read does echo the tag back** on Microsoft
   (`captures/phase1/microsoft/05-metadata-filter.json`). Never special-case Microsoft as
   "tag always absent" — it is absent on the create/update response only.

---

## Architecture Summary

⚠⚠ **This is the DESIGN. Almost none of it is wired today** (checked 2026-08-18 against
`main` @ `eb6d4b2`). Read it as the target flow, not as a map of code you can go and open:

| Step                                          | State                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| SDK client + error boundary                   | **shipped but INERT** — `apps/api/src/lib/apiroc/`, no caller outside its tests |
| `calendar_connections` per (expert, provider) | **shipped** — BAL-467, migration `0067`                                         |
| Connect / callback / free-busy / event writes | **not built** — every calendar route is still Cronofy (BAL-396)                 |
| Apiroc webhook route, subscriptions, renewal  | **not built**; `svix` is not even a dependency (BAL-468)                        |
| `vendorBusyProvider.listBusyBlocks`           | **returns `[]`** — the availability seam exists, unwired                        |

Per-area detail, with the real signatures, is in `references/`.

```
Expert connects calendar (Google / Microsoft)
  → getOAuthUrl(appId, provider, { redirectUrl, externalId, state })
  → Apiroc hosted OAuth → redirect back to our callback
  → ⚠ CALLBACK HAS THREE SHAPES — branch on `error` FIRST:
        ?error=missing_required_permissions&error_description=…   (no account created)
        ?endUserAccountId=<id>&state=<state>                       (happy path)
        neither                                                    (must not crash)
  → persist endUserAccountId + credentialStatus per (expert, provider) — NOT tokens
  → calendars.list(endUserAccountId) → save calendar list + primary + target calendar
  → calendarSubscriptions.create(endUserAccountId, {
        calendarId, webhookUrl, subscriptionType: 'event', rateLimit? })
      → store webhookSubscriptionId + endpointSecret PER SUBSCRIBED CALENDAR
      → read `expiration` from calendarSubscriptions.list — the CREATE RESPONSE OMITS IT
      → Google/Microsoft only

Calendar changes externally (Google/Microsoft)
  → Apiroc POSTs a thin { eventType, timestamp } via Svix to Balo's per-subscription URL
  → identity comes from the URL PATH — the body carries none
  → verify with svix lib over svix-id / svix-timestamp / svix-signature + endpointSecret
  → dedupe on svix-id; ack 2xx immediately
  → BullMQ job (deduped on `availability-${expertProfileId}`):
      windowed freeBusy.get re-read over the whole forward window (NO delta read)
  → recompute earliest_available_at → update availability_cache

Client views expert profile
  → render page immediately (bio, rate, etc.)
  → async: freeBusy.get(endUserAccountId, { startDateTime, endDateTime, timeZone, calendarIds })
  → union busy intervals across the expert's provider accounts
  → apply BAL-195 weekly rules + padding/duration in OUR slot calculator
  → Redis cache: short TTL keyed by expertId + date

Consultation booked
  → events.create(endUserAccountId, targetCalendarId, {
       ..., transparency: 'opaque',
       privateExtendedProperties: { baloBookingId } })
  → store the RETURNED event id on the consultation record (never a derived id — §M1)

Consultation cancelled
  → events.delete(endUserAccountId, targetCalendarId, storedEventId)

Expert revokes access at the provider
  → NOTHING TELLS US. No webhook fires; credentialStatus stays ACTIVE.
  → detected only by a failed data call — either the scheduled health probe (BAL-396 §9)
    or, if that is missing, a client trying to book.
```

> **No delta read anywhere in that flow.** An earlier version of this summary had the webhook
> job do `events.list(..., { syncToken })` and persist `nextSyncToken`. That is a full
> **event** read, which contradicts Constraint 4 below — _"Free/busy only for availability…
> busy slots, no titles — privacy by design"_. **Constraint 4 wins.** Availability is always
> recomputed from a windowed free/busy read (BAL-447 / ADR-1021 amendment 2026-08-15).

---

## Provider-parity table

**The highest-value artefact in this document.** Reproduced verbatim from BAL-393 FINDINGS.md
§"Phase 1 — Microsoft". **[live]** — the same call matrix run against a throwaway Google
account and a throwaway Microsoft account. **Apiroc unifies the request shape but NOT the
semantics** — every divergence below is a place an adapter written against Google alone would
be wrong.

| Behaviour                                  | Google                                 | Microsoft                                        | Impact                            |
| ------------------------------------------ | -------------------------------------- | ------------------------------------------------ | --------------------------------- |
| Caller-supplied event `id`                 | **honoured** — returns the id you sent | **200 OK, silently substituted** with a Graph id | ⚠⚠ see M1                         |
| `nextSyncToken`                            | on the final page                      | **never returned, on any page**                  | ⚠⚠ see M2                         |
| `privateExtendedProperties` echoed on read | `{"baloBookingId":"spike-test-1"}`     | **echoed on a filtered read; `{}` on writes**    | see M3                            |
| `metadataFilters` query                    | works                                  | **works** (negative-control verified)            | M3                                |
| `allowedOnlineMeetingProviders`            | `["hangoutsMeet"]`                     | `[]` — none                                      | no Teams link generation          |
| Calendar `timeZone`                        | populated (`Australia/Melbourne`)      | **absent**                                       | can't rely on it; use Balo's tz   |
| `isPrimary` on non-primary                 | **field omitted**                      | **explicitly `false`**                           | treat absent AND false as false   |
| `busySlots` timeZone label                 | `UTC`                                  | `Etc/UTC`                                        | don't string-compare tz names     |
| `dateTime` precision                       | `2026-08-20T10:00:00Z`                 | `2026-08-20T10:00:00.000Z`                       | parse, never string-compare       |
| Final page of pagination                   | last page has data + `nextSyncToken`   | emits an **extra empty page** (`count: 0`)       | one extra round-trip to terminate |
| Calendar id format                         | email address                          | 152-char opaque Graph id                         | must be URL-encoded in paths      |

### M1 — ⚠⚠ Microsoft silently ignores a caller-supplied event `id`

`POST` with `id: "bal393spikecustomid001"` returned **HTTP 200** — and an event whose id is a
Graph id (`AQMkADAwATM3ZmYBLWI3MmMtNWU3OS0wMAItMDAK…`). Not a rejection. Not an error. **A
success response that quietly did something else.**

A rejection would fail loudly in CI. This fails **silently and only in production, only for
Microsoft-based experts** — an idempotent-create-by-derived-id design looks correct in every
Google test, then double-books on every retry for Microsoft.

**→ Caller-supplied ids are NOT a portable idempotency lever.** Store the **vendor-returned**
event id and key idempotency off Balo's own record. If a derived id is ever used, assert the
returned id equals the requested one and treat a mismatch as an error. _(The spike's own
harness had exactly this bug: it judged the probe on `status < 400` and reported a false
pass.)_

### M2 — ⚠⚠ Microsoft never returns `nextSyncToken`

Paginated to exhaustion at `pageSize=1` over 3 events: pages 1–3 returned keys
`data, nextPageToken`, page 4 returned `data` alone (0 items) — **`nextSyncToken` absent on
every page.** A complete unpaginated list likewise returned keys `data` only. Google's
identical call returns `nextSyncToken` on the final page. **There is no delta-read mechanism
for Microsoft through this API.**

Balo's ruling (BAL-447) is that **no provider delta-syncs** — see Constraint 3. The matrix,
its evidence, and the ruling live in `apps/api/src/services/calendar/sync-capability.ts`,
guarded by `apps/api/src/invariants/sync-token-parity.test.ts`.

### M3 — Microsoft drops the tag from WRITE responses, but a filtered read returns it

⚠ **Corrected 2026-08-18 against the raw capture.** An earlier revision of this section said
the tag "came back `{}` on create, on read, and after `PUT`" and concluded it is _never_
readable on Microsoft. **The read half of that is false.** Re-checked against
`captures/phase1/microsoft/05-metadata-filter.json`, a `metadataFilters` list read returns
`"privateExtendedProperties": {"baloBookingId": "spike-test-1"}` **[live]**.

What is actually true:

| Microsoft operation                  | `privateExtendedProperties` in the response |
| ------------------------------------ | ------------------------------------------- |
| `events.create` response             | `{}` — dropped **[live]**                   |
| `events.update` (`PUT`) response     | `{}` — dropped **[live]**                   |
| `events.list` with `metadataFilters` | **echoed in full [live]**                   |

So the tag **is** persisted, **is** queryable, and **is** readable — it is only the write
responses that omit it. `publicExtendedProperties` is `{}` on the write responses too, so it
isn't merely relocated. The query itself was verified with a negative control (a filter that
was silently ignored would also "match 1 of 1"):

| Query                                              | Result                    |
| -------------------------------------------------- | ------------------------- |
| two events created, tagged `tag-AAA` and `tag-BBB` | —                         |
| `metadataFilters={"baloBookingId":"tag-AAA"}`      | → exactly `BAL393 A` ✔    |
| `metadataFilters={"baloBookingId":"tag-BBB"}`      | → exactly `BAL393 B` ✔    |
| `metadataFilters={"baloBookingId":"tag-NOPE"}`     | → `[]` ✔ (filter is real) |

**→ Reconciliation by _querying_ the tag works on both providers, and the fetched events carry
the tag on both.** The single rule that survives: **never verify a write by reading the echo
off its own create/update response** — on Microsoft that field is empty even though the write
succeeded. Verify by querying instead. ⚠ Do not write a mapper that special-cases Microsoft as
"tag always absent": it is absent on write responses only, and such a mapper would discard a
tag that is really there.

---

## Where the rules live

This skill has two layers. **SKILL.md is the load-bearing summary — the constraints, the
provider divergences, and the evidence.** The `references/*.md` sub-files carry the _how_: the
as-built code patterns a builder needs open in front of them while writing a calendar path.
Read SKILL.md first, then exactly the reference your task touches.

| Reference                                 | Read it when you are…                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `references/sdk-adapter.md`               | Adding or changing any Apiroc call — the boundary, error normalisation, retry, logging   |
| `references/connect-and-credentials.md`   | Touching connect, the OAuth callback, credential status, reconnect, or disconnect        |
| `references/availability-and-freebusy.md` | Touching free/busy, the slot calculator, the availability cache, or anything sync-shaped |
| `references/webhooks-and-events.md`       | Touching inbound webhooks / subscriptions, or writing consultation events to a calendar  |

⚠ The references describe **shipped code** and are versioned with it. Where a reference and
this file disagree, the reference is describing what is actually in the repo — fix the drift
rather than picking a side.

**The artefacts themselves**, which both layers point at:

| Subject                                                  | Where                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| All captured runtime behaviour (the evidence)            | `spikes/apiroc-probe/FINDINGS.md` on the BAL-393 branch (PR #211)        |
| The sync-strategy ruling + provider capability matrix    | `apps/api/src/services/calendar/sync-capability.ts` (shipped, **inert**) |
| The guard that keeps delta-sync out                      | `apps/api/src/invariants/sync-token-parity.test.ts`                      |
| The single busy-block port every availability path uses  | `apps/api/src/services/availability/vendor-busy.ts`                      |
| The SDK adapter boundary (error + logging)               | `apps/api/src/lib/apiroc/`                                               |
| Connection model + SDK adapter boundary                  | BAL-467 (shipped, PR #219)                                               |
| Connect, free/busy, event write, reconnect, health probe | BAL-396                                                                  |
| Webhooks, subscription lifecycle, renewal                | BAL-468                                                                  |
| Pre-consent explainer + partial-grant recovery UX        | BAL-462                                                                  |
| OAuth app registration (BYOC branding + scopes)          | BAL-394                                                                  |
| Vendor liaison (bug reports, auto-renew question)        | BAL-455                                                                  |

---

## SDK Initialisation

```typescript
// apps/api/src/lib/apiroc.ts
import { UnifiedCalendarApi } from '@apiroc/unified-calendar-api-node-sdk';
import { getOAuthUrl } from '@apiroc/unified-calendar-api-node-sdk/oauth';

// Single client — API key only. There is NO per-user token client (vendor holds tokens).
export const apiroc = new UnifiedCalendarApi({
  apiKey: process.env.APIROC_API_KEY!,
  // unifiedApiBaseUrl defaults to https://api.apiroc.com
  // timeout defaults to 30000ms
});

// OAuth URL is a standalone helper; appId is passed per-call (not part of the client).
// Signature: getOAuthUrl(appId, 'GOOGLE' | 'MICROSOFT', params?) — APPLE is NOT a valid
// provider here; iCloud would connect via basicAuth.connect instead (parked, Constraint 8).
export function connectUrl(provider: 'GOOGLE' | 'MICROSOFT', state: string) {
  return getOAuthUrl(process.env.APIROC_APP_ID!, provider, {
    redirectUrl: process.env.APIROC_REDIRECT_URI!,
    externalId: /* our stable expert ref */ undefined,
    state, // signed { expertId, nonce }; doubles as CSRF
    loginHint: /* optional prefill email */ undefined,
  });
}
```

**Resource surface (verified, v2.0.1 [stat]):**
`apiroc.calendars` · `apiroc.events` · `apiroc.endUserAccounts` · `apiroc.freeBusy` ·
`apiroc.calendarSubscriptions` · `apiroc.basicAuth`. Unchanged from v1 — **the v2 break is
narrower than the major bump suggests**: the client class, all six resource classes, every
method signature, the error classes, and `EndUserAccountCredentialStatus` are the same. The
two real deltas are the default base URL and the now-required `subscriptionType`.

**Key method signatures [stat]:**

```typescript
calendars.list(endUserAccountId, params?)            // → PaginatedResponse<Calendar>
calendars.get/create/update/delete(...)              // Balo creates NO calendars
events.list(endUserAccountId, calendarId, params?)   // params: startDateTime, endDateTime,
                                                     //   timeZone, metadataFilters, search,
                                                     //   expandRecurrences, isAllDay,
                                                     //   isCancelled, updatedAfter, orderBy,
                                                     //   pageToken, pageSize, syncToken
events.create(endUserAccountId, calendarId, data)    // data supports private/publicExtendedProperties
events.update(endUserAccountId, calendarId, eventId, data)
events.delete(endUserAccountId, calendarId, eventId) // → { success: true }
events.getOccurrences(endUserAccountId, calendarId, eventId, params?)  // recurring series
events.rsvp(endUserAccountId, calendarId, eventId, { responseStatus })
freeBusy.get(endUserAccountId, { startDateTime, endDateTime, timeZone, calendarIds })
  // ⚠ returns a BARE ARRAY (FreeBusySlot[]), not a { data } envelope like every list endpoint
calendarSubscriptions.create(endUserAccountId, {
  calendarId,                       // required for subscriptionType 'event'
  webhookUrl,                       // MUST be HTTPS
  subscriptionType: 'event',        // ⚠ REQUIRED in v2 — 'calendar' | 'event'
  rateLimit?,                       // messages/sec, min 1
})                                  // → { webhookSubscriptionId, endpointSecret } ONLY
calendarSubscriptions.list(endUserAccountId, params?)   // ← the ONLY place `expiration` appears
calendarSubscriptions.delete(endUserAccountId, subscriptionId)
  // ⚠ id travels in the request BODY, not the path (see Constraint 12)
endUserAccounts.get(id) / .list(params?) / .upsert(data) / .delete(id) / .getCredentials(id)
basicAuth.connect(appId, 'apple', { email, password })   // iCloud — PARKED, see Constraint 8
```

> That list is the **vendor's** surface, not Balo's sanctioned surface. `events.list`'s
> `syncToken` / `updatedAfter` / `expandRecurrences` params exist on the SDK and Balo uses
> **none of them** for availability — availability comes from `freeBusy.get` only (Constraints
> 3 and 4). `events.list` is sanctioned **only** for reconciling Balo's own tagged
> consultation events, via `metadataFilters`. Reading a vendor capability as permission is
> exactly the mistake BAL-447 closed, and
> `apps/api/src/invariants/sync-token-parity.test.ts` now fails the build for it.

**Environment variables required:**

```
APIROC_API_KEY=
APIROC_APP_ID=
APIROC_REDIRECT_URI=https://api.balo.expert/auth/apiroc/callback
# Webhook signature secret is returned per-subscription (endpointSecret) and stored in DB —
# it is NOT a single global env var.
```

---

## DB Schema (Drizzle)

⚠ **This is the TARGET shape. Part of it has since shipped — check which half you are
reading.** Corrected 2026-08-18 against `packages/db/src/schema/calendar.ts` @ `eb6d4b2`.

| Claim below                                            | Reality in `main` today                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unique on `(expertId, provider)`                       | ✅ **SHIPPED** (BAL-467, migration `0067`) — partial, on `deleted_at IS NULL`                                                                                                                          |
| `endUserAccountId` column                              | ✅ shipped — but **nullable**, not `.notNull()`                                                                                                                                                        |
| `credentialStatus` with `ACTIVE \| EXPIRED \| REVOKED` | ❌ **does not exist.** The column is `status`, CHECK-constrained to `connected \| sync_pending \| auth_error`. Writing `'ACTIVE'` fails `23514`. Rename is BAL-396 §2/§9                               |
| No token columns                                       | ❌ `access_token` / `refresh_token` / `cronofy_sub` / `token_expires_at` all still there, now **nullable** — the table is dual-tenanted Cronofy+Apiroc for one release (BAL-396 drops the Cronofy arm) |
| `calendar_subscriptions` table                         | ❌ **does not exist at all** (BAL-468). `calendar_sub_calendars` is a different thing                                                                                                                  |
| `availability_cache`                                   | ✅ shipped and live                                                                                                                                                                                    |

**Read the real file before writing a query.** Full as-built column list, the upsert arbiter,
and the cardinality invariant are in `references/connect-and-credentials.md`.

```typescript
// calendar_connections — pointer + status, NOT tokens. Unique on (expertId, provider).
export const calendarConnections = pgTable('calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertProfileId: uuid('expert_profile_id')
    .notNull()
    .references(() => expertProfiles.id),
  endUserAccountId: text('end_user_account_id').notNull(), // Apiroc account id (pointer)
  provider: text('provider').notNull(), // google | microsoft
  credentialStatus: text('credential_status').notNull().default('ACTIVE'), // ACTIVE | EXPIRED | REVOKED
  targetCalendarId: text('target_calendar_id'), // where consultations are written
  lastSyncedAt: timestamp('last_synced_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// calendar subscriptions — one row per SUBSCRIBED CALENDAR, not per expert
export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => calendarConnections.id),
  calendarId: text('calendar_id').notNull(),
  webhookSubscriptionId: text('webhook_subscription_id').notNull(),
  endpointSecret: text('endpoint_secret').notNull(), // encrypted at rest; signature verify
  expiration: timestamp('expiration'), // ⚠ read from .list(), NEVER from the create response
});

// availability_cache — one row per expert (NOT a full event mirror)
export const availabilityCache = pgTable('availability_cache', {
  expertProfileId: uuid('expert_profile_id')
    .primaryKey()
    .references(() => expertProfiles.id),
  earliestAvailableAt: timestamp('earliest_available_at'),
  updatedAt: timestamp('updated_at').defaultNow(),
});
```

**Encrypt `endpoint_secret` at rest** (AES-256, key from env). No provider tokens are stored
by Balo.

**There is no `sync_token` column, and none is planned.** Balo stores no delta cursor for any
provider — see Constraint 3 (BAL-447 / ADR-1021 amendment 2026-08-15).

---

## Key Constraints & Gotchas

> ⚠ **The numbering is load-bearing.** `apps/api/src/services/calendar/sync-capability.ts`
> and `apps/api/src/invariants/sync-token-parity.test.ts` both cite "Constraint 4" by number.
> Correct a constraint in place; **append** new ones. Never renumber.

1. **Vendor holds tokens.** Never store provider access/refresh tokens. Persist the
   `endUserAccountId`. ⚠ **Do NOT drive reconnect off `credentialStatus`** — that rule was
   refuted; see Constraint 10 and
   [Credential expiry & reconnect detection](#credential-expiry--reconnect-detection).
2. **Subscriptions are per-calendar** (`calendarId` required for `subscriptionType: 'event'`),
   not per-expert — subscribe each conflict-check calendar you need change-push for;
   Google/Microsoft only. ⚠ **They DO expire — a hard 7 days [live]**, and the create response
   hides it (`expiration` is absent from `CreateCalendarSubscriptionResponse` entirely). Read
   `expiration` from `calendarSubscriptions.list`. Whether Apiroc auto-renews before expiry is
   **unconfirmed** — treat renewal as caller-managed until the vendor says otherwise
   (BAL-468 §3). On reconnect see Constraint 11 for the ordering — it is **not**
   delete-then-recreate.
3. **There is no delta key. Balo does not delta-sync.** `syncToken` / `nextSyncToken` is never
   read and never stored, on any provider. Three reasons: (a) the sync token lives on
   `events.list`, while availability is sourced from `freeBusy.get`, which has **no delta
   mode** on either provider; (b) switching availability to full event reads would violate
   Constraint 4's privacy posture; (c) capability is not even uniform — Microsoft never returns
   a token (§M2) and Google only on the final page (§P3). Every change webhook enqueues a
   whole-window re-read instead — one strategy for every provider, with no provider-conditional
   sync path. The matrix, its evidence, and the ruling live in
   `apps/api/src/services/calendar/sync-capability.ts` (BAL-447 / ADR-1021 amendment
   2026-08-15).
4. **Free/busy only for availability.** Use `freeBusy.get` (busy slots, no titles) for the
   slot picker — privacy by design, consistent with fee/detail concealment posture. Only read
   full events when we need our own tagged consultation events (filter via `metadataFilters`
   on `baloBookingId`). ⚠ `freeBusy.get` returns a **bare array**, not a `{ data }` envelope
   **[live]**.
5. **Slot rules are ours.** Apply BAL-195 weekly schedule, duration, and padding in Balo's slot
   calculator over the returned busy slots. Apiroc does not compute bookable slots.
6. **Forward window — there are TWO horizons, and neither is 60 days.** ⚠ An earlier
   revision said "carry the 60-day convention"; **no 60-day value exists anywhere in the
   repo.** Shipped: a **14-day advertise horizon** (`resolve-and-cache.ts`, overridable via
   the `RESOLVER_HORIZON_DAYS` env, default 14) for what the availability cache and expert
   search reason about, and a **365-day booking horizon**
   (`MAX_BOOKING_HORIZON_DAYS` in `@balo/shared/meetings`) for how far ahead a meeting may be
   placed. Cap `freeBusy.get` to the horizon of the caller's question — do not invent a third.
   See `references/availability-and-freebusy.md`.
7. **Target calendar for writes.** Write consultation events to the expert's
   `targetCalendarId` (defaults to the `isPrimary` calendar on first connect); tag with
   `privateExtendedProperties.baloBookingId`. **Balo creates no calendars.**
8. **iCloud is PARKED.** Google + Microsoft only (BAL-395 / BAL-396); `apple` / `icloud` is
   deliberately absent from the shipped provider union in `sync-capability.ts`. If it is ever
   revived: it connects via `basicAuth.connect` with an Apple app-specific password (no OAuth
   redirect), and it has **no change webhooks** — its availability would need on-demand
   `freeBusy.get` at profile view plus a low-frequency poll, not push.
9. **Paginate to exhaustion — never trust page 1.** Apiroc's own reference app reads only the
   first page; do not copy that. Follow `nextPageToken` until it is absent. ⚠ Sharpened by §P3:
   on Google, **`nextSyncToken` and `nextPageToken` are mutually exclusive and the sync token
   appears ONLY on the final page** — so a reader that stops early never obtains one and
   silently degrades to a full read forever, with no error anywhere. **Default page size is
   400**, so any calendar under 400 events returns everything on page 1: the bug is invisible
   in dev and on test accounts, and only appears on a busy expert's real calendar. Test with a
   forced small `pageSize`. Microsoft emits an **extra trailing empty page** (`count: 0`) — the
   loop must terminate cleanly on it. Balo stores no sync token (Constraint 3), but the
   pagination rule still governs every `events.list` reconciliation query (BAL-396 §5,
   BAL-468 §2).
10. **Reconnect detection is error-driven, not status-driven.** `endUserAccounts.get()` and
    `getCredentials()` both keep reporting `ACTIVE` — **with both tokens present** — after the
    user has revoked at the provider. The status only flips to `EXPIRED` once a data call has
    already failed **[live]**. Polling status as a health check is worthless as a leading
    indicator. A health probe must issue a real **data call** (`calendars.list` is the lightest
    known-good one) — BAL-396 §9.
11. **Reconnect ordering is reconnect-FIRST.** Deleting a subscription is forbidden while the
    credential is `EXPIRED` (`403 "End user account credential expired"` **[live]**) — and the
    credential is expired precisely _because_ the user revoked, which is why you are
    reconnecting. So: **reconnect → delete stale subscriptions → re-create.** This works
    because `endUserAccountId` is stable across a revoke/reconnect cycle (**[live]**: same id
    returned, `createdAt` unchanged, `updatedAt` moved) — reconnect is an UPDATE, not an
    INSERT, and no orphan row is left behind. Cleanup must be **verified, not best-effort**: a
    stale subscription keeps delivering duplicate webhooks for up to 7 days (BAL-468 §4).
12. **`calendarSubscriptions.delete` puts the id in the request BODY**, not the path:
    `DELETE /api/v1/calendarSubscriptions/{endUserAccountId}` with `{ data: { subscriptionId } }`
    **[stat + live]**. The obvious path-style guess
    (`DELETE /calendarSubscriptions/{acct}/{id}`) returns `404` and leaves the record intact.
    DELETE-with-a-body is unusual and some proxies drop it silently — go through the SDK, never
    hand-roll it.
13. **`subscriptionType: 'calendar'` is broken — HTTP 500 [live].** The account-wide variant
    ("all calendars, no `calendarId`") returns an unhandled exception, leaking internals:

    ```json
    {
      "error": "InternalServerError",
      "message": "init[\"status\"] must be in the range of 200 to 599, inclusive."
    }
    ```

    **Only `event` subscriptions work**, so Balo subscribes **per calendar**: N subscriptions
    per expert to create, track, and renew. Reported to the vendor via BAL-455.

14. **Microsoft calendar ids are 152-char opaque Graph strings** and **must be URL-encoded** in
    paths (the SDK does `encodeURIComponent` on them **[stat]** — do the same anywhere you build
    a URL by hand). Google's are email addresses.

---

## Error Handling

### There is no machine-readable error code on the wire. Branch on HTTP status.

**[live] — full Phase 0 probe run, base `https://api.apiroc.com`.** Two mutually incompatible
error envelopes, plus a third vocabulary on the OAuth callback:

- **Envelope A** (401 / 404, presumably 5xx) — `{ error, message, requestId }`. The `error`
  field is **not even consistently typed**: the literal string `"Error"` on auth/account
  failures, but the **number `404`** on an unknown _calendar_. A TypeScript type for it would
  be `string | number`, which is by itself enough reason never to branch on it. Even `message`
  degrades: an unknown account says `"End user account not found"`, an unknown calendar says
  only `"Not Found"`. (Resolution order is account, then calendar.)
- **Envelope B** (400 validation) — `{ success: false, error: { name: "ZodError", message } }`.
  **No top-level `message`. No `requestId` in the body.** The nested `error.message` is a
  **double-encoded JSON string** of a Zod issue array; `JSON.parse` it to recover field paths
  and reasons.
- **OAuth callback** — a query string, `?error=missing_required_permissions&error_description=…`.
  The only snake_case, genuinely enumerable vocabulary of the three. Appears nowhere else.

**409 is captured [live], contra the "still unverified" note below.** A Google create with a
duplicate caller-supplied id returns Envelope A with a **numeric** `error`:
`{"error": 409, "message": "The requested identifier already exists.", …}`. Traced through the
shipped boundary it classifies to `kind: 'unknown'`, which is **never retried** — so a
derived-id retry fails un-retryably on Google while silently double-booking on Microsoft
(§M1). One more reason caller-supplied ids are not an idempotency lever.

Six distinct values of the wire `error` field have been observed: `"Error"`, `404`,
`"InvalidRefreshToken"`, `"InternalServerError"`, a `ZodError` object, and (callback only)
`missing_required_permissions`. **Do not read it as an enum.**

**`x-request-id` is on the response HEADER of every response** (200s included). On Envelope A
it is duplicated into the body; on Envelope B the header is the **only** copy.

### How the SDK normalises it [stat, all confirmed live]

| HTTP                    | Thrown class              | `.code`                | Source of `.code`                                                      |
| ----------------------- | ------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| 401                     | `AuthenticationError`     | `AUTHENTICATION_ERROR` | hardcoded constant                                                     |
| 403                     | `AuthorizationError`      | `AUTHORIZATION_ERROR`  | hardcoded constant                                                     |
| 404                     | `NotFoundError`           | `NOT_FOUND`            | hardcoded constant                                                     |
| 429                     | `RateLimitError`          | `RATE_LIMIT_EXCEEDED`  | hardcoded constant; `.retryAfter` parsed from the `Retry-After` header |
| 400 / 409 / 5xx / other | `APIRequestError`         | `data?.code`           | **always `undefined`** — the API sends `data.error`, never `data.code` |
| no HTTP response        | `UnifiedCalendarApiError` | —                      | network / timeout                                                      |

⚠ **A 401 does not mean "bad API key".** It also means "this expert's credential was revoked"
— see [Credential expiry & reconnect detection](#credential-expiry--reconnect-detection).

**Retry policy:** `400` never (permanent programming error) · `401` / `403` never (credential
problem → reconnect) · `404` never · `429` back off by `retryAfter` · `5xx` and network yes.

### Five SDK defects the adapter must work around

1. **On a 400 the SDK discards the entire error payload [live].** The interceptor computes
   `message = data?.message || error.message`, but Envelope B has no top-level `message` — so
   it falls through to axios's generic **`"Request failed with status code 400"`**. `code` and
   `details` are `undefined` for the same reason. **Every validation failure is
   indistinguishable from every other one through the SDK**: which field was wrong, and why, is
   thrown away before it reaches the caller.
2. **`.code` carries no information.** For 401/403/404/429 it is a hardcoded constant that
   merely restates the HTTP status; for 400/409/5xx it is `undefined`. `details` is always
   `undefined` (no such wire field). **Below the HTTP status there is no machine-readable
   signal at all.**
3. **`requestId` is silently dropped [live].** Present as the `x-request-id` header on every
   response and in the body on Envelope A; the interceptor copies neither onto the thrown
   error. Vendor support escalation would have nothing to quote.
4. **All four subclasses extend `APIRequestError`**, which extends `UnifiedCalendarApiError`.
   An `instanceof APIRequestError` branch therefore **also catches** 401/403/404/429 — order
   checks **most-specific-first**. `Object.setPrototypeOf` is called in every constructor, so
   `instanceof` is reliable. ⚠ **Never branch on `error.constructor.name`** — the bundler
   mangles it to `_AuthenticationError`. (`error.name` _is_ set explicitly to
   `"AuthenticationError"` and is stable **[stat]**, but `instanceof` is still the right check.)
5. **The axios instance is private on both hops [stat].** `UnifiedCalendarApi.baseClient` and
   `BaseClient.client` are both declared `private`. TypeScript `private` is compile-time only,
   so the instance is reachable at runtime — but there is **no supported, typed accessor**.
   Plan the boundary as a call wrapper, or accept an explicitly-documented reach through two
   private fields; do not assume a public hook exists.

### Own the boundary — BAL-467 §2

**Do not consume the SDK's thrown errors directly.** Wrap the SDK (or install an interceptor
ahead of the SDK's own) and, before the failure is mangled, capture: the `x-request-id` header
→ attach it to the error and log it; the raw response body → on Envelope B,
`JSON.parse(body.error.message)` to recover the Zod issue array (field paths + reasons) for
logs. Then branch on **HTTP status only**.

### The SDK logs to the console itself and cannot be silenced [stat]

It builds a module-level `winston` logger with an **unconditional `Console` transport** and
logs **every** API error at `error` level, plus request/response at `debug`. The level comes
from `process.env.LOG_LEVEL` (default `info`) — and since `error` is winston's level 0, **no
`LOG_LEVEL` value suppresses the error lines**. They bypass Pino, carry no `requestId` /
`userId`, never reach Axiom as structured logs, and still pollute stdout on Railway — in direct
conflict with CLAUDE.md's logging rules. The boundary must patch or replace that transport
(BAL-467 §2).

### Hardcoded stale `User-Agent` [stat]

v2.0.1 sends `unified-calendar-api-node-sdk/0.1.0`. Vendor-side telemetry cannot tell our SDK
version — don't rely on the vendor identifying our client during support.

### `ValidationError` is exported but never thrown ✅

Confirmed **[live + stat]** — server-side 400s arrive as `APIRequestError`; the SDK's
`ValidationError` is constructed nowhere in the response path. Input validation is ours (zod).
**Don't write a catch branch for it on API calls.**

### Rate limits

`Retry-After` → `RateLimitError.retryAfter` is confirmed **structurally [stat]**; the sandbox
**magnitude is still unverified** — the rate-limit probe was never run. Vendor-documented
**[docs]**: per API key, 300 req/s production and 20 req/s sandbox (raisable via support); per
end-user-account on calendar/event endpoints, Google 600/min and Microsoft 1000/min (fixed).
Provider-side limits also apply — size BullMQ concurrency/backoff accordingly, and treat the
numbers as unverified until something measures them.

---

## Credential expiry & reconnect detection

### ⚠⚠ `credentialStatus` LIES until something has already failed

**[live]** Access revoked at `myaccount.google.com/permissions` on a throwaway account:

| Moment                       | `endUserAccounts.get().status` | `getCredentials()`                                          | `calendars.list()`          | `freeBusy`               |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- | --------------------------- | ------------------------ |
| baseline (healthy)           | `ACTIVE`                       | `200`, both tokens present                                  | `200`, 4 calendars          | `200`                    |
| **immediately after revoke** | **`ACTIVE`** ← stale           | **`200`, `ACTIVE`, both tokens STILL present** ← stale      | `401` `InvalidRefreshToken` | `403` credential expired |
| after one failed data call   | **`EXPIRED`**                  | `403` `{"error":"Error","message":"Invalid refresh token"}` | `403`                       | `403`                    |

1. **The status flip is LAZY — event-based, not time-based.** It flips on the first failed data
   call, not after any interval. Polling `endUserAccounts.get()` is a _lagging_ record of a
   failure you have already seen.
2. **A user-initiated REVOKE surfaces as `EXPIRED`, not `REVOKED`.** On Google, `REVOKED` looks
   unreachable in practice — **build no distinct UX for the two**; treat any non-`ACTIVE` value
   as "reconnect required".
3. **The same condition yields different errors depending on timing:**

|                  | Pre-flip                                                                               | Post-flip                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `calendars.list` | `401` `{"error":"InvalidRefreshToken","message":"Token has been expired or revoked."}` | `403` `{"error":"Error","message":"End user account credential expired"}` |
| SDK              | `AuthenticationError` / `AUTHENTICATION_ERROR`                                         | `AuthorizationError` / `AUTHORIZATION_ERROR`                              |

⚠ **The 401 case is genuinely dangerous.** Through the SDK, a revoked _end-user credential_
throws the **same class and the same code** as a bad _platform API key_. One means "one expert
must reconnect"; the other means "Balo's calendar integration is down for everyone". They are
indistinguishable except by the `message` string or the wire `error` field the SDK discards —
one more reason the boundary in BAL-467 §2 has to exist. _(Ironically `InvalidRefreshToken`,
the one genuinely machine-readable value on the wire, is the exact example the first version of
this skill dismissed as "opaque and unenumerated".)_

### ⚠⚠ There is NO proactive reconnect signal

**[live]** Tested with a **live `event` subscription in place** and a webhook receiver running:
**0 deliveries over 5.5 minutes**, spanning both the revocation itself and the
`ACTIVE → EXPIRED` transition. No `enduseraccount.credential.updated`, no
`enduseraccount.updated`, nothing at all.

Stated honestly: account-level events may only be delivered on a **`calendar`-type**
subscription — the type that returns HTTP 500 (Constraint 13) — so the capability might exist
and merely be unreachable. The practical conclusion is unchanged: **today there is no way to
receive a proactive credential signal.** Re-check if BAL-455 gets the 500 fixed; if it ever
fires, the health probe can be relaxed, not removed.

The composed failure:

> An expert revokes calendar access. Balo keeps showing them as connected, `status` stays
> `ACTIVE`, no webhook arrives, nothing changes — **until a client tries to book them.** The
> failure surfaces in front of a paying client.

### What the adapter must do (BAL-396 §2, §9)

1. Detect from the **data call** — map `401` + wire `error: "InvalidRefreshToken"` **and**
   `403` + `"End user account credential expired"` onto one internal `RECONNECT_REQUIRED`.
2. Distinguish a revoked **expert credential** from a bad **platform API key**.
3. Re-read `endUserAccounts.get()` **after** the failure to confirm, and persist to
   `calendar_connections.credential_status`.
4. Run a **scheduled health probe** issuing a cheap data call per live connection —
   `calendars.list` is the lightest known-good one. **Not** `endUserAccounts.get()`: polling
   status cannot work, per the table above. Publish the reconnect notification through
   `notificationEvents.publish()` — never a direct Brevo call.

---

## Subscriptions & lifecycle

| Fact                                                             | Value **[live]**                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Create response fields                                           | **only** `{ webhookSubscriptionId, endpointSecret }`                 |
| `expiration` on the **create response**                          | **the key is absent from the response body entirely** ← the trap     |
| `expiration` in the stored record (`calendarSubscriptions.list`) | a real timestamp — **exactly 7 days** after creation                 |
| Provider channel identifiers                                     | `subscriptionId` (uuid) + `resourceId` — Google `watch` channel refs |
| `endpointSecret`                                                 | present, 38 chars                                                    |
| `subscriptionType: 'calendar'`                                   | **HTTP 500** — unusable (Constraint 13)                              |
| Delete while credential `EXPIRED`                                | **403** — forbidden (Constraint 11)                                  |

**The trap:** `CreateCalendarSubscriptionResponse` carries no `expiration` field at all, so a
caller reading only the create response sees nothing and concludes subscriptions never
expire — which is very likely how this skill's original claim arose.

7 days matches Google's maximum `watch` channel TTL, so Apiroc appears to pass the provider's
channel expiry straight through. **Whether Apiroc auto-renews before that expiry is
unconfirmed** and cannot be settled without a 7-day observation — the vendor question is
BAL-455, the job is BAL-468 §3. Treat renewal as caller-managed until told otherwise: the
failure mode is silent and platform-wide (every expert's sync dies a week after connecting,
with no error raised anywhere), so the asymmetry favours building the sweep. Add the cheap
monitor regardless — a daily check for subscriptions expiring inside 48h catches the bad case
either way.

---

## Webhooks (Google/Microsoft)

**The complete body [live]. This is all of it:**

```json
{ "eventType": "calendar.event.changed", "timestamp": "2026-08-14T07:37:20.129Z" }
```

| Fact                                               | Observed **[live]**                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Headers                                            | `svix-id`, `svix-timestamp`, `svix-signature` all present                                    |
| Account/calendar identity in the body?             | **None.** A programmatic scan for any key matching `account\|calendar\|resource\|id$` → `[]` |
| Signature verifies with `svix` + `endpointSecret`? | **VALID** on every delivery                                                                  |
| Event types observed                               | `calendar.event.changed` only                                                                |
| Do rapid successive changes coalesce?              | **Yes** — 8 changes produced 5 deliveries, batched in roughly 10s windows                    |

**→ Encoding `endUserAccountId` / `calendarId` in the per-subscription `webhookUrl` is
REQUIRED, not a stylistic choice.** The path is the _only_ way to know which expert a ping
belongs to.

**Consequences:**

- Never infer _what_ changed from a ping — it carries no event id. And never chase the change
  with a delta read: enqueue the whole-window rebuild (Constraint 3).
- The rebuild job must be **debounced and deduped per expert**
  (`jobId: availability-${expertProfileId}`). One job per webhook wastes work; one job per
  _change_ is impossible anyway.
- **Dedupe on `svix-id`** — every delivery had a distinct one, so it is a usable idempotency
  key.
- **Ack fast** — the receiver returned `200` immediately and Svix never retried.
- `webhookUrl` **must be HTTPS [docs + stat]**. (Plain `http://localhost` _is_ accepted for the
  OAuth `redirectUrl`, so connect-flow work needs no tunnel — but webhooks do.)

Event types the vendor documents **[docs]**: `calendar.event.changed`, `calendar.event.unknown`,
and `enduseraccount.created` / `updated` / `deleted` / `credential.updated`. ⚠ Only the first
was ever observed, and `credential.updated` demonstrably **does not fire on revocation** — see
above.

```typescript
import { Webhook } from 'svix';

const wh = new Webhook(endpointSecret); // per-subscription secret, decrypted
const payload = wh.verify(rawBody, {
  'svix-id': req.headers['svix-id'],
  'svix-timestamp': req.headers['svix-timestamp'],
  'svix-signature': req.headers['svix-signature'],
}); // throws on bad signature → reject. ⚠ Only "2xx stops retries" is [live];
// nothing establishes how Svix treats a 4xx here. Design for "any non-2xx is retried"
// and make the handler idempotent rather than relying on a status to suppress delivery.
// then enqueue a BullMQ whole-window availability rebuild — never a delta (Constraint 3)
```

Svix retries failed deliveries with exponential backoff (immediately, 5s, 5m, 30m, 2h, 5h, 10h,
10h) and disables an endpoint that keeps failing for ~5 days **[docs]**.

---

## OAuth connect & callback

**The callback has three shapes and the handler must branch on `error` FIRST.** A handler that
assumes the happy shape will crash or, worse, persist `undefined` as a live connection.

| Shape                                                     | Meaning                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `?endUserAccountId=<id>&state=<state>` **[live]**         | Success. The param really is `endUserAccountId`; `state` round-trips intact. |
| `?error=missing_required_permissions&error_description=…` | Partial consent — **no account was created**. Persist nothing.               |
| neither                                                   | Must not crash.                                                              |

### Partial consent is rejected server-side by Apiroc ✅ [live]

Google's consent screen has **granular per-scope checkboxes**, and completing the flow with
both unchecked produces the `missing_required_permissions` callback above — **no
`endUserAccountId`, no account created.** The vendor validates scope grants server-side, so
Balo cannot end up storing a live pointer to a calendar it can't read. The half-connected
account risk is mitigated **by the vendor**, not by us — which is exactly why the callback must
handle the error shape.

⚠ **Re-consent does not re-show the checkboxes.** Once granted, Google collapses the screen to
"Apiroc already has some access", **even with `prompt=consent`**. Fixing a partial grant
requires the expert to revoke at `myaccount.google.com/permissions` first — **reconnect copy
must say so** or they loop. Pre-consent explainer and recovery copy are BAL-462.

`prompt=select_account` correctly forces the provider account chooser **[live]**.

**`redirectUrl` must be allowlisted** in the dashboard (_Application Details → Authorized
Redirect URIs_). `http://localhost:8787/callback` was accepted there **[live]** — plain HTTP on
localhost is not rejected for OAuth.

---

## Hypothesis ledger

The first version of this skill was written from docs and SDK types. BAL-393 probed each
standing claim against the live sandbox. **Four of six refuted.**

| #   | Original claim                                                                              | Verdict                                                                                                       |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| H1  | Subscriptions **don't expire**; the vendor auto-renews, so **no renewal job is needed**     | ❌ **REFUTED** — hard **7-day** expiry, hidden from the create response. Auto-renew still unconfirmed.        |
| H2  | Webhook body is a thin `{ eventType, timestamp }` carrying **no account/calendar identity** | ✅ **CONFIRMED [live]** — exactly that. URL-encoded identity is required.                                     |
| H3  | The string `code` is **opaque and unenumerated**, passed through from the API body          | ❌ **REFUTED** — hardcoded per status class, `undefined` on `APIRequestError`; the body has no `code` at all. |
| H4  | `ValidationError` is exported but **never thrown**                                          | ✅ **CONFIRMED [live + stat]** — server-side 400s arrive as `APIRequestError`.                                |
| H5  | Reconnect must be driven off `credentialStatus`, **not** off error codes                    | ❌ **REFUTED** — status is stale until a data call has already failed. Detection is purely error-driven.      |
| H6  | Sandbox rate limit is 20 req/s per API key, with `Retry-After` on 429                       | ◐ `Retry-After` → `RateLimitError.retryAfter` confirmed **structurally [stat]**; magnitude unverified.        |

H3 is worth one more line, because the original advice landed on the right answer for the wrong
reason: the `code` **is** safe for control flow (it is five hardcoded constants) — it simply
carries no information the HTTP status doesn't. The thing that _is_ opaque and unenumerated is
the wire `error` field, which the SDK never exposes.

Two further claims were corrected outside the hypothesis set: the **SDK/package identity** (v1
`@onecal` → v2.0.1 `@apiroc`, new base URL, `subscriptionType` now required), and the
**architecture** — the old "webhook → `events.list({syncToken})` delta read" flow was
Google-only in capability and is now **ruled out for every provider** by BAL-447.

---

## Still unverified — do not write code that assumes these

| Question                                                                     | Status                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Apiroc auto-renew subscriptions before the 7-day expiry?                | **Unknown.** Needs a 7-day observation or a vendor answer (BAL-455).                                                                                             |
| Actual sandbox rate-limit magnitude; is `Retry-After` really emitted?        | **Unmeasured.** The rate-limit probe was never run.                                                                                                              |
| 5xx wire shapes                                                              | **Assumed Envelope A, unverified** — not reachable synthetically. (**409 is now CAPTURED** — see below.)                                                         |
| Do subscriptions survive a revoke → reconnect cycle?                         | **Untested.** The account id does; the subscriptions are open.                                                                                                   |
| Would `credential.updated` fire on a working `calendar` subscription?        | **Unknowable** until the 500 (Constraint 13) is fixed.                                                                                                           |
| Does BYOC put Balo's branding on the consent screen? Can scopes be narrowed? | **Open — BAL-394.** Microsoft currently has `Calendars.ReadWrite` **without** `.Shared`, so shared/delegate calendars are likely invisible to Microsoft experts. |
