---
name: onecal
description: >
  Integration patterns for the OneCal Unified Calendar API (Apiroc) within Balo — the
  calendar vendor chosen in ADR-1021. Use this skill whenever implementing or modifying
  any calendar-related feature: expert calendar connection (Google/Microsoft OAuth,
  iCloud Basic Auth), listing calendars, subscribing to change webhooks to update the
  availability cache, fetching free/busy for the expert profile slot picker, writing or
  deleting consultation events, tagging events with balo_consultation_id, and applying
  the weekly-schedule availability rules (BAL-195) in Balo's own slot calculator. Also
  covers the endUserAccountId pointer model, credential-status-driven reconnect UX, and
  error handling. Trigger on any mention of OneCal, Apiroc, unified calendar, calendar
  sync, OAuth calendar, iCloud calendar, availability, free/busy, calendar webhook /
  subscription, syncToken, calendar events, or availability rules.
---

# OneCal (Apiroc) Unified Calendar Integration Skill

> Vendor: **OneCal** / Apiroc Unified Calendar API (ADR-1021). SDK
> `@onecal/unified-calendar-api-node-sdk` (verified against **v1.2.2**).
> Default API base: `https://api.onecalunified.com`. Docs: OneCal still shows some
> naming inconsistency (docs have appeared at both `docs.apiroc.com` and
> `docs.onecalunified.com`) — do not hard-code a docs domain; treat both as live until
> the vendor settles it.

## Balo-Specific Context

OneCal is Balo's calendar infrastructure. It handles:

- **Connection** — expert connects Google / Microsoft via OneCal hosted OAuth (BYOC:
  the consent screen shows Balo's branding), and iCloud via Basic Auth (app-specific
  password).
- **Calendar listing** — surfaces all calendars (Work, Personal, etc.) for the
  conflict-check toggle UI.
- **Change webhooks** — OneCal POSTs to Balo's webhook when an expert's calendar
  changes; Balo does a `syncToken` delta read and recalculates availability.
- **Availability cache update** — on webhook, Balo recomputes and stores
  `earliest_available_at` per expert (one DB row, not a full event mirror).
- **Free/busy fetch** — when a client views an expert's profile, Balo calls OneCal
  `freeBusy.get` for the forward window to populate the slot picker.
- **Event write / delete** — consultation booked → create event on the expert's primary
  calendar, tagged with `privateExtendedProperties.balo_consultation_id`; cancelled →
  delete by stored external event id.
- **Availability rules (BAL-195)** — the expert's weekly schedule is stored in **Balo's
  DB** and applied by **Balo's slot calculator** over OneCal free/busy. OneCal has **no
  server-side availability-rule primitive** (unlike the prior Cronofy design — see
  "Deltas from the Cronofy design" below).

**Stack:** TypeScript, Fastify (backend on Railway), Drizzle ORM, BullMQ + Redis.
**SDK:** `pnpm add @onecal/unified-calendar-api-node-sdk`

---

## Deltas from the Cronofy design (read first if porting old code)

1. **Vendor holds the tokens.** We store only an `endUserAccountId` pointer + a
   credential status. No encrypted `access_token` / `refresh_token` columns. OneCal
   refreshes provider tokens itself.
2. **Reconnect signal is a typed enum, not an error string.** Drive "reconnect your
   calendar" UX off `EndUserAccountCredentialStatus` (`ACTIVE | EXPIRED | REVOKED`), not
   off sniffing error codes. (See Error Handling.)
3. **No server-side Availability Rules.** BAL-195 weekly schedule is Balo-owned data
   applied in our slot calculator. `freeBusy.get` returns raw busy slots only.
4. **iCloud uses Basic Auth**, not OAuth — a separate connection path with its own UX
   (app-specific password). Google/Microsoft use hosted OAuth.
5. **Incremental sync via `syncToken`**, returned as `nextSyncToken` on sync-enabled
   paginated reads — carry it forward per webhook. (No Cronofy-style change channels.)
6. **Custom event tagging** via `privateExtendedProperties` / `publicExtendedProperties`
   (`Record<string,string>`), and `list()` can filter by them via `metadataFilters`.

---

## Architecture Summary

```
Expert connects calendar
  Google/Microsoft: send to getOAuthUrl(appId, provider, { redirectUrl, externalId, state })
    → OneCal hosted OAuth → redirect back to our callback with endUserAccountId
  iCloud: basicAuth.connect(appId, "apple", { email, appSpecificPassword })
    → returns EndUserAccount
  → persist endUserAccountId + credentialStatus (NOT tokens)
  → calendars.list(endUserAccountId) → save calendar list + primary
  → calendarSubscriptions.create(endUserAccountId, { webhookUrl, subscriptionType })
      → store webhookSubscriptionId + endpointSecret (per expert)

Calendar changes externally
  → OneCal POSTs to /webhooks/onecal  [payload/signature scheme: PENDING VENDOR]
  → verify signature with stored endpointSecret
  → BullMQ job: events.list(..., { syncToken }) delta read → persist nextSyncToken
  → recompute earliest_available_at → update availability_cache

Client views expert profile
  → render page immediately (bio, rate, etc.)
  → async: freeBusy.get(endUserAccountId, { startDateTime, endDateTime, timeZone, calendarIds })
  → apply BAL-195 weekly rules + padding/duration in OUR slot calculator
  → Redis cache: short TTL keyed by expertId + date

Consultation booked
  → events.create(endUserAccountId, primaryCalendarId, {
       ..., privateExtendedProperties: { balo_consultation_id } })
  → store returned event id on the consultation record

Consultation cancelled
  → events.delete(endUserAccountId, primaryCalendarId, eventId)
```

---

## Reference Files

> **Port status:** the `references/*.md` sub-files below were written for Cronofy and
> still need porting to OneCal. Update each before relying on it. Table renamed to the
> OneCal surface.

| Task                                                                   | Reference File                     |
| ---------------------------------------------------------------------- | ---------------------------------- |
| OAuth connect (Google/MS) + iCloud Basic Auth + endUserAccount pointer | `references/connect.md`            |
| List calendars + conflict-check toggle logic                           | `references/calendars.md`          |
| Webhook subscription + signature verify + syncToken delta read         | `references/webhooks.md`           |
| Free/busy fetch + slot calculator + Redis cache pattern                | `references/free-busy.md`          |
| Write / delete / tag consultation events                               | `references/events.md`             |
| Availability rules (BAL-195 weekly schedule) — Balo-side computation   | `references/availability-rules.md` |
| Error handling + credential-status reconnect recovery                  | `references/errors.md`             |

---

## SDK Initialisation

```typescript
// apps/api/src/lib/onecal.ts
import { UnifiedCalendarApi } from '@onecal/unified-calendar-api-node-sdk';
import { getOAuthUrl } from '@onecal/unified-calendar-api-node-sdk/oauth';

// Single client — API key only. There is NO per-user token client (vendor holds tokens).
export const onecal = new UnifiedCalendarApi({
  apiKey: process.env.ONECAL_API_KEY!,
  // unifiedApiBaseUrl defaults to https://api.onecalunified.com
  // timeout defaults to 30000ms
});

// OAuth URL is a standalone helper; appId is passed per-call (not part of the client).
export function connectUrl(provider: 'GOOGLE' | 'MICROSOFT', state: string) {
  return getOAuthUrl(process.env.ONECAL_APP_ID!, provider, {
    redirectUrl: process.env.ONECAL_REDIRECT_URI!,
    externalId: /* our stable expert/user ref */ undefined,
    state, // e.g. base64 { userId }; prefer externalId for durable identity mapping
    loginHint: /* optional prefill email */ undefined,
  });
}
```

**Resource surface (verified, v1.2.2):**
`onecal.calendars` · `onecal.events` · `onecal.endUserAccounts` · `onecal.freeBusy` ·
`onecal.calendarSubscriptions` · `onecal.basicAuth`.

**Key method signatures:**

```typescript
calendars.list(endUserAccountId, params?)
events.list(endUserAccountId, calendarId, params?)   // params: startDateTime, endDateTime,
                                                     //   expandRecurrences, metadataFilters,
                                                     //   search, updatedAfter, syncToken, paging
events.create(endUserAccountId, calendarId, data)    // data supports private/publicExtendedProperties
events.update(endUserAccountId, calendarId, eventId, data)
events.delete(endUserAccountId, calendarId, eventId)
events.getOccurrences(endUserAccountId, calendarId, eventId, params?)  // recurring series
events.rsvp(endUserAccountId, calendarId, eventId, data)
freeBusy.get(endUserAccountId, { startDateTime, endDateTime, timeZone, calendarIds })
calendarSubscriptions.create(endUserAccountId, { webhookUrl, subscriptionType, calendarId?, rateLimit? })
  // → { webhookSubscriptionId, endpointSecret }
calendarSubscriptions.list(endUserAccountId, params?) / .delete(endUserAccountId, subscriptionId)
endUserAccounts.get(id) / .list(params?) / .delete(id) / .getCredentials(id)
basicAuth.connect(appId, 'apple', { email, password })   // iCloud app-specific password
```

**Environment variables required:**

```
ONECAL_API_KEY=
ONECAL_APP_ID=
ONECAL_REDIRECT_URI=https://api.balo.expert/auth/onecal/callback
# Webhook signature secret is returned per-subscription (endpointSecret) and stored in DB —
# it is NOT a single global env var.
```

---

## DB Schema (Drizzle)

```typescript
// calendar_connections — pointer + status, NOT tokens
export const calendarConnections = pgTable('calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertId: uuid('expert_id')
    .notNull()
    .references(() => experts.id),
  endUserAccountId: text('end_user_account_id').notNull(), // OneCal account id (pointer)
  provider: text('provider').notNull(), // google | microsoft | apple
  credentialStatus: text('credential_status').notNull().default('ACTIVE'), // ACTIVE | EXPIRED | REVOKED
  webhookSubscriptionId: text('webhook_subscription_id'),
  endpointSecret: text('endpoint_secret'), // encrypted at rest; signature verify
  syncToken: text('sync_token'), // last nextSyncToken for delta reads
  lastSyncedAt: timestamp('last_synced_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// calendar_calendars — one row per calendar surfaced by calendars.list
export const calendarCalendars = pgTable('calendar_calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => calendarConnections.id),
  calendarId: text('calendar_id').notNull(), // OneCal calendar id
  name: text('name').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  conflictCheck: boolean('conflict_check').notNull().default(true),
  color: text('color'),
});

// availability_cache — one row per expert (NOT a full event mirror)
export const availabilityCache = pgTable('availability_cache', {
  expertId: uuid('expert_id')
    .primaryKey()
    .references(() => experts.id),
  earliestAvailableAt: timestamp('earliest_available_at'),
  updatedAt: timestamp('updated_at').defaultNow(),
});
```

**Encrypt `endpoint_secret` at rest** (AES-256, key from env). No provider tokens are
stored by Balo.

---

## Key Constraints & Gotchas

1. **Vendor holds tokens.** Never store provider access/refresh tokens. Persist the
   `endUserAccountId` and drive reconnect off `credentialStatus`.
2. **One webhook subscription per expert.** On reconnect, `calendarSubscriptions.delete`
   the old subscription before creating a new one; store the fresh
   `webhookSubscriptionId` + `endpointSecret`.
3. **`syncToken` is the delta key.** Store `nextSyncToken` from each sync-enabled read;
   pass it on the next `events.list`. Handle a "full resync required" response by
   clearing the stored token and doing a full window read. _(Exact invalidation
   semantics: PENDING VENDOR.)_
4. **Free/busy only for availability.** Use `freeBusy.get` (busy slots, no titles) for
   the slot picker — privacy by design, consistent with fee/detail concealment posture.
   Only read full events when we need our own tagged consultation events (filter via
   `metadataFilters` on `balo_consultation_id`).
5. **Slot rules are ours.** Apply BAL-195 weekly schedule, duration, and padding in
   Balo's slot calculator over the returned busy slots. OneCal does not compute bookable
   slots.
6. **Forward window.** Cap `freeBusy.get` / event reads to `now → now + N days`
   (carry the 60-day convention unless changed).
7. **Primary calendar for writes.** Write consultation events to the calendar where
   `is_primary = true`; tag with `privateExtendedProperties.balo_consultation_id`.
8. **iCloud is Basic Auth.** The connect UX must instruct the expert to generate an
   Apple app-specific password; there is no OAuth redirect for Apple.
9. **Paginate.** OneCal's own reference app reads only the first page — do not copy that.
   Follow `nextPageToken` on large calendars.

---

## Error Handling

The SDK maps HTTP status → typed error (all extend `UnifiedCalendarApiError`):

| Status              | Error class               | Retry?          | Notes                                                                  |
| ------------------- | ------------------------- | --------------- | ---------------------------------------------------------------------- |
| 401                 | `AuthenticationError`     | No              | Bad API key / auth                                                     |
| 403                 | `AuthorizationError`      | No              |                                                                        |
| 404                 | `NotFoundError`           | No              |                                                                        |
| 429                 | `RateLimitError`          | Yes             | `retryAfter` seconds (from `Retry-After` header) — feed BullMQ backoff |
| other (400/409/5xx) | `APIRequestError`         | 5xx yes; 4xx no | carries `status`, optional opaque `code`, `details`                    |
| no HTTP response    | `UnifiedCalendarApiError` | Yes             | network/timeout                                                        |

- The fine-grained string `code` (e.g. `InvalidRefreshToken`) is **opaque and
  unenumerated** — passed through from the API body, only on generic `APIRequestError`.
  Use it for telemetry/logging, not control flow. _(Full code list: PENDING VENDOR.)_
- `ValidationError` is exported but **never thrown** in v1.2.2 — input validation is ours
  (zod). Don't write a catch branch for it on API calls.
- **Reconnect trigger = `EndUserAccountCredentialStatus`** (`ACTIVE | EXPIRED |
  REVOKED`), read via `endUserAccounts.get(id)` / `.getCredentials(id)`. On
  `EXPIRED`/`REVOKED`, set `calendar_connections.credential_status` and surface the
  reconnect-calendar UX. Do not gate this on error-code strings.

---

## Pending Vendor Confirmation

These are unresolved from the SDK/reference app (questions sent to OneCal 17 Jul 2026).
Do **not** implement blind — flag to Yomi if a ticket depends on one:

1. **Webhook payload shape + signature scheme** for `endpointSecret` (HMAC of raw body?
   which header? replay protection?) and delivery-retry behaviour on non-2xx.
2. **Subscription lifecycle** — do subscriptions expire (provider TTLs) and does OneCal
   auto-renew, or must we re-create on a schedule?
3. **`syncToken` invalidation** — the "full resync required" response contract.
4. **Free/busy on iCloud** — does `freeBusy.get` return busy slots for Apple accounts?
5. **Rate-limit numbers** — per-account / per-endpoint limits.
6. **Error-code enumeration** — full set of `code` values, esp. credential/auth failures.
