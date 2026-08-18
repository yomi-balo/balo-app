# Apiroc connection lifecycle — connect, callback, credentials, reconnect, disconnect

Depth material for anyone writing or changing a connect / reconnect / disconnect path against
Apiroc. `SKILL.md` carries the _why_ (vendor behaviour, the provider-parity table, the
hypothesis ledger, the credential-expiry evidence); this file carries the _how_ — the shipped
`calendar_connections` shape, the exact state-signing and callback branching a handler must do,
what may and may not be persisted, and the ordering rules that make reconnect work. Read it
before touching `apps/api/src/routes/calendar/*`, `packages/db/src/schema/calendar.ts`, or
`packages/db/src/repositories/calendar.ts`. Evidence tags match SKILL.md: **[live]** observed
against the real API in the BAL-393 spike, **[stat]** read out of the published SDK bundle,
**[docs]** vendor docs only. Untagged prose is a Balo design rule, or a description of Balo's
own shipped code.

✅ **BAL-396 (PR #221) is merged into this branch. Apiroc is the live connect/callback/credential
path.** Cronofy is gone entirely: `apps/api/src/lib/cronofy.ts` and
`apps/api/src/services/cronofy/` no longer exist, migration `0069_bal396_cronofy_removal.sql`
dropped every Cronofy identity column (`cronofy_sub`, `access_token`, `refresh_token`,
`token_expires_at`, `channel_id`) from `calendar_connections` and the two orphan
`expert_profiles` columns (`cronofy_user_id`, `cronofy_sync_status`), and `end_user_account_id`
is `NOT NULL`. Everywhere this file used to say "inert" or "the pattern BAL-396 reuses," read the
real, shipped file instead — this reconciliation replaces every such claim with the as-built
code. What is still genuinely unbuilt is called out explicitly and attributed to its own ticket
(BAL-468 webhooks/subscriptions, BAL-397 the multi-connection settings UI, BAL-462 the re-consent
explainer).

---

## 1. The connection model, as built

### 1.1 What shipped in `calendar_connections`

`packages/db/src/schema/calendar.ts`; migrations `0067_bal467_apiroc_per_provider_connections.sql`
(the per-provider unique + `end_user_account_id`), `0068_bal396_apiroc_credential_status.sql` (the
`status` → `credential_status` rename and vocabulary swap), `0069_bal396_cronofy_removal.sql` (the
Cronofy column drop + `NOT NULL`).

| Column                  | Type                            | As-built truth                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | uuid pk                         | Balo row id. Churns on reconnect-after-disconnect — see §5.4.                                                                                                                                                                                                                                               |
| `expert_profile_id`     | uuid not null                   | FK to expert_profiles.id, ON DELETE cascade                                                                                                                                                                                                                                                                 |
| `end_user_account_id`   | text not null (since 0069)      | The only vendor identity Balo stores. Non-unique — see the index table below.                                                                                                                                                                                                                               |
| `provider`              | text not null                   | 'google' \| 'microsoft' lowercase, no CHECK on it                                                                                                                                                                                                                                                           |
| `provider_email`        | text nullable                   | display only                                                                                                                                                                                                                                                                                                |
| `credential_status`     | text not null, default 'ACTIVE' | Renamed from status by migration 0068. Vocabulary: ACTIVE \| SYNC_PENDING \| EXPIRED \| REVOKED — see §5.1                                                                                                                                                                                                  |
| `credential_checked_at` | timestamptz, nullable           | Last time a real data call proved this credential works. Stamped by the health probe (§5.3) and by upsertApirocConnection on connect/reconnect                                                                                                                                                              |
| `reconnect_notified_at` | timestamptz, nullable           | "Already notified about the current breakage" marker — see §5.2/§5.3                                                                                                                                                                                                                                        |
| `last_synced_at`        | timestamptz, nullable           | Effectively dead. Its only production writer was the Cronofy webhook route BAL-396 deleted; nothing writes it any more, so every row's value is permanently NULL. findStaleConnections (§1.4) was repointed to credential_checked_at for exactly this reason — do not resurrect a query against this column |
| `target_calendar_id`    | text nullable                   | Event-write target, per connection (ADR-1021 amendment §1)                                                                                                                                                                                                                                                  |
| timestamps / softDelete |                                 | created_at, updated_at, deleted_at                                                                                                                                                                                                                                                                          |

Indexes and constraints — the Cronofy-era ones (cal_conn_cronofy_sub_idx, cal_conn_channel_id_idx)
are gone, dropped by migration 0069 alongside their columns:

| Index / constraint                       | Shape                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| cal_conn_expert_provider_idx             | UNIQUE on (expert_profile_id, provider) WHERE deleted_at IS NULL                                 |
| cal_conn_end_user_account_idx            | non-unique on end_user_account_id WHERE deleted_at IS NULL — deliberately non-unique, see below  |
| cal_conn_credential_check_idx            | on credential_checked_at WHERE deleted_at IS NULL — the health probe's oldest-checked-first scan |
| cal_conn_credential_status_check (CHECK) | credential_status IN ('ACTIVE', 'SYNC_PENDING', 'EXPIRED', 'REVOKED')                            |

**A "connection" is one (expert, provider) pair.** One expert may hold a live Google connection
and a live Microsoft connection simultaneously; each is a distinct Apiroc End User Account and
its own row. Availability is the **union** of busy blocks across all of an expert's live
connections. Connect, disconnect, and reconnect are **per provider** (ADR-1021, amendment
18 Aug 2026 §1).

⚠ `cal_conn_end_user_account_idx` is **non-unique on purpose, and this was re-examined and
confirmed, not merely carried over, in BAL-396** (ADR-1021 amendment 18 Aug 2026 §5). Nothing in
the vendor docs establishes that one Apiroc End User Account maps to at most one Balo expert —
the vendor keys an account on (app, provider, email), not on Balo's `externalId`, and two Balo
experts connecting the same Google account is routine in dev and seed data. The index's docblock
in `schema/calendar.ts` and `invariants/calendar-connection-cardinality.test.ts` both assert this
table declares **exactly one** unique index, so a future attempt to tighten this to unique needs
vendor evidence first, not just a hunch. See §7's disconnect section for a place this cardinality
still bites.

⚠ **SKILL.md's "DB Schema (Drizzle)" section is now the accurate summary, and this section is its
detail.** Both should agree that the table has no token columns, `end_user_account_id` is
`NOT NULL` and non-unique, and `credential_status` carries the four-value vendor-mirroring
vocabulary. If they ever disagree, this file is the one to trust — SKILL.md itself says so.

### 1.2 What the cardinality invariant forbids

`packages/db/src/invariants/calendar-connection-cardinality.test.ts` runs in the **unit** job
(no Docker) over live table metadata and repository source. It fails on four specific wrong
codes, in three layers plus one more over the Drizzle relations:

| Wrong code                                                                      | Why it is wrong                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Any index keyed on `expert_profile_id` alone, under any name                    | Restores the one-connection-per-expert world the amendment repealed                                            |
| Dropping the unique index's `WHERE deleted_at IS NULL`                          | Disconnect soft-deletes → reconnect fails 23505 against a row the application cannot see                       |
| Moving `deleted_at` into the key columns instead                                | Looks equivalent, does the opposite: NULL is not equal to itself in a unique index → unlimited live duplicates |
| An ON CONFLICT arbiter naming `expertProfileId` alone, or missing `targetWhere` | Arbiter inference fails at plan time → every upsert raises 42P10, including the first on an empty table        |

It also pins `schema/experts.ts` to `many(calendarConnections)` — a singular `one(...)` relation
names an arbitrary one of two live rows — by reading that file's source text directly (a
source-text check, dodgeable by an aliased import, and the test's own docblock says so). It also
carries "positive control" tests per layer (an index actually parses, an upsert actually exists,
the extraction actually found what the count of `.insert(calendarConnections)` call sites says it
should) specifically so a broken extractor cannot pass the whole suite vacuously — the test file's
own docblock names this as its design bar, set by `sync-token-parity.test.ts`. Behavioural proof
(two providers coexist, 23505 on a duplicate, reconnect-after-disconnect) lives in
`repositories/calendar.integration.test.ts` and needs real Postgres.

### 1.3 The upsert arbiter — copy this exactly

```typescript
// packages/db/src/repositories/calendar.ts — calendarRepository.upsertApirocConnection
await db
  .insert(calendarConnections)
  .values({
    expertProfileId,
    provider,
    endUserAccountId,
    providerEmail,
    credentialStatus,
    deletedAt: null,
  })
  .onConflictDoUpdate({
    target: [calendarConnections.expertProfileId, calendarConnections.provider],
    // MANDATORY. The arbiter index is PARTIAL; Postgres only selects a partial index
    // as an ON CONFLICT arbiter when the statement RESTATES its predicate.
    targetWhere: isNull(calendarConnections.deletedAt),
    set: {
      // `provider` is INTENTIONALLY absent — it is half the arbiter.
      endUserAccountId,
      providerEmail,
      credentialStatus,
      reconnectNotifiedAt: null, // clears the notify-once marker so a SECOND breakage notifies again
      credentialCheckedAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
  })
  .returning();
```

This is the real, shipped `calendarRepository.upsertApirocConnection` — the **only** writer that
mints a `calendar_connections` row in the Apiroc world; `upsertConnection`,
`updateConnectionTokens`, `updateConnectionChannelId`, `findConnectionByChannelId`, and the
expert-wide `updateConnectionStatus` fan-out are all **deleted**, not renamed (see §1.4).

⚠ Typecheck, lint, and the mocked unit test all stay **green** without `targetWhere` (the unit
test mocks Drizzle and only records the argument object). Only the integration suite catches it.
`isNull()` renders `"deleted_at" is null` with **no bound parameter**, so this is not the
`reference_pg_partial_index_arbiter_param_42p10` hazard — do not "fix" it into raw `sql`.

### 1.4 Repository surface, by class

`calendarRepository` methods are classified in-file. Pick by class, never by convenience. Every
method below is now checked against its **actual live callers** on this branch, not projected —
"INERT" means what it says: zero callers outside tests, today.

| Method                              | Class            | Live callers today                                                                                                                                                                           |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findConnectionByExpertProfileId`   | legacy-single    | `routes/calendar/api.ts` (`GET /api/calendar/connection`'s single-connection `connection` shape, BAL-397 replaces it)                                                                        |
| `findConnectionByExpertAndProvider` | provider-scoped  | `routes/calendar/api.ts` (`set-target-calendar` with an explicit `provider`), `services/calendar/apiroc-connection.ts` (`disconnectProvider`)                                                |
| `listConnectionsByExpertProfileId`  | fan-out          | `routes/calendar/api.ts` (`GET /connection`'s `connections` array, `disconnect`'s whole-account loop, `findConnectionOwningCalendar`)                                                        |
| `findConnectionsByEndUserAccountId` | pointer          | Still INERT — no caller until BAL-468's webhook handler resolves an inbound End User Account. Returns an array — the index is non-unique on purpose (§1.1)                                   |
| `upsertApirocConnection`            | provider-scoped  | `services/calendar/apiroc-connection.ts` (`persistApirocConnection`, called from the OAuth callback — §3.2). The only connection writer                                                      |
| `setCredentialStatusForProvider`    | provider-scoped  | `services/calendar/apiroc-connection.ts` (`provisionConnection`) — replaces the deleted expert-wide `updateConnectionStatus` fan-out                                                         |
| `setCredentialStatus`               | connection-keyed | `services/calendar/credential-status.ts` (`flipToReconnectRequired`), `jobs/calendar-health-probe.ts` (recovery path)                                                                        |
| `markCredentialChecked`             | connection-keyed | `jobs/calendar-health-probe.ts` — the probe's scan-key stamp, on EVERY attempt including a classified failure                                                                                |
| `markReconnectNotified`             | connection-keyed | `services/calendar/credential-status.ts` — stamped after the notification publish, never before                                                                                              |
| `updateLastSyncedAt`                | connection-keyed | No live caller. Its only production writer was the Cronofy webhook route BAL-396 deleted — see `lastSyncedAt`'s note in §1.1                                                                 |
| `updateTargetCalendarIdForProvider` | provider-scoped  | `routes/calendar/api.ts` (`set-target-calendar`), `services/calendar/apiroc-connection.ts` (`provisionConnection`'s first-connect default)                                                   |
| `findConnectionWithSubCalendars`    | legacy-single    | `routes/calendar/api.ts` — backs `GET /connection`'s legacy `connection` shape                                                                                                               |
| `softDeleteConnection`              | fan-out          | `routes/calendar/api.ts` (`disconnect` with `provider` absent — the whole-account backstop, run after the per-provider loop)                                                                 |
| `softDeleteConnectionForProvider`   | provider-scoped  | `services/calendar/apiroc-connection.ts` (`disconnectProvider`) — per-provider disconnect is now real, see §7                                                                                |
| `findStaleConnections`              | unaffected       | `jobs/availability-cache.ts` — the 15-minute staleness cron. Repointed from `last_synced_at` to `credential_checked_at` by BAL-396's fix round (see §1.1); the old column had no writer left |
| `listConnectionsDueForHealthCheck`  | unaffected       | `jobs/calendar-health-probe.ts` — the probe's candidate scan (§5.3)                                                                                                                          |
| `listBusyReadTargets`               | unaffected       | `services/availability/vendor-busy.ts` — the free/busy read's connection list. Returns non-ACTIVE and unprovisioned connections too, deliberately, so the booking gate can fail closed       |

⚠ **The Cronofy-era fan-outs `updateConnectionStatus` (expert-wide status) and
`updateTargetCalendarId` (expert-wide target calendar) are DELETED, not merely superseded.** They
no longer exist in `packages/db/src/repositories/calendar.ts` at all. The "known imprecision"
they used to represent (one provider's failure branding the other provider's row) cannot recur
through them because they are gone; every write is now provider-scoped or connection-keyed by
construction.

⚠ `findConnectionsByEndUserAccountId` returning an array remains deliberate for the reason in
§1.1: nothing establishes a vendor one-to-one guarantee, and two experts connecting the same
Google account is routine in dev and seed data.

### 1.5 Tables that do NOT exist yet

SKILL.md's schema block also shows a `calendar_subscriptions` table with `endpointSecret` and
`expiration`. **No such table is in `packages/db` today.** It is BAL-468's. What does exist is
`calendar_sub_calendars` — the per-connection calendar list (`calendar_id`, `name`, `provider`,
`profile_name`, `is_primary`, `conflict_check`, `color`), unique on `(connection_id, calendar_id)`,
FK `ON DELETE cascade`. Do not conflate the two: sub-calendars are the conflict-check toggle list;
subscriptions are the webhook registrations. `profile_name` stores the connection's
`providerEmail` at provisioning time (`services/calendar/apiroc-connection.ts`) — display
metadata, not an identity field.

---

## 2. The connect flow, end to end

### 2.1 Building the authorize URL

The real, shipped call — `apps/api/src/lib/apiroc/oauth.ts::buildApirocAuthorizeUrl`, invoked from
`POST /api/calendar/connect` (`routes/calendar/auth.ts`):

```typescript
import { getOAuthUrl } from '@apiroc/unified-calendar-api-node-sdk/oauth';

// toApirocProviderType: 'google' -> 'GOOGLE', 'microsoft' -> 'MICROSOFT'. The ONE translation
// point for the SDK's uppercase ProviderType — every Balo-side surface stays lowercase.
getOAuthUrl(process.env.APIROC_APP_ID!, toApirocProviderType(provider), {
  redirectUrl: process.env.APIROC_REDIRECT_URI!, // must be allowlisted — §2.4
  externalId: expertProfileId, // opaque to Apiroc; NOT an identity lever — §2.3
  state: signConnectState(expertProfileId, provider), // CSRF + identity — §2.2
});
```

⚠ **Balo does not pass `loginHint` or `prompt` today.** Both remain valid optional SDK
parameters **[stat]** (the account-chooser and login-prefill behaviour described below is real,
observed vendor behaviour), but the shipped `buildApirocAuthorizeUrl` only forwards `redirectUrl`,
`externalId`, and `state`. If a future slice wants to prefill the provider login form or force the
account chooser, add the parameter here — it is not there today.

The helper is pure string-building **[stat]** — it makes no network call:

```typescript
// dist/oauth/index.js, v2.0.1 [stat] — faithfully reduced
const url = `${baseUrl}/api/v1/oauth/authorize/${appId}/${provider.toLowerCase()}`;
if (params?.redirectUrl) queryParams.append('redirectUrl', params.redirectUrl);
if (params?.externalId) queryParams.append('externalId', params.externalId);
// … loginHint, prompt, state — same `if (truthy)` guard on every one
```

⚠⚠ **Every parameter is appended only if truthy [stat].** `state: ''` is silently dropped and you
get an authorize URL with **no CSRF token at all** — no throw, no warning, and the flow still
completes. Never let `state` be derived from a possibly-empty value; `signConnectState` always
throws first if `INTERNAL_API_SECRET` is unset, so the shipped call site cannot reach this trap by
accident — but a future call site building `state` some other way could.

| Param               | Type [stat]                         | Balo rule                                                                                |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `appId`             | positional, required                | `APIROC_APP_ID` — read (and validated) in `oauth.ts`, not `client.ts`                    |
| `provider`          | `'GOOGLE' \| 'MICROSOFT'` uppercase | Lowercased into the path by the SDK. APPLE is not accepted here                          |
| `redirectUrl`       | optional string                     | Always pass it; must be dashboard-allowlisted                                            |
| `externalId`        | optional string                     | Balo's stable expert ref. Never trusted for identity — §2.3                              |
| `loginHint`         | optional string                     | Optional email prefill — not sent by Balo's shipped call (see above)                     |
| `prompt`            | optional string, not an enum        | `select_account` forces the account chooser **[live]** — not sent by Balo's shipped call |
| `state`             | optional string                     | Signed, non-empty, round-trips intact on success **[live]**                              |
| `unifiedApiBaseUrl` | optional                            | Defaults `https://api.apiroc.com`. Leave unset                                           |

⚠ **Provider casing crosses three vocabularies.** The SDK wants `'GOOGLE'`/`'MICROSOFT'`; Balo's
DB, zod schemas, and `CALENDAR_PROVIDERS` in `services/calendar/sync-capability.ts` all use
lowercase `'google'`/`'microsoft'`. Cronofy used `'office365'` for Microsoft; that translation
(`api.ts::mapProvider`'s old `office365` branch) is **gone** — migration `0069` removed every
Cronofy-era row, the only source of that value, so `mapProvider` today narrows defensively (a
garbage value falls back to `'google'`) rather than translating a value that can no longer occur.
**Store lowercase.** Convert at the SDK boundary only (`oauth.ts::toApirocProviderType`).

### 2.2 `state` — signing, verification, and the CSRF-binding cookie

The signed-state primitive lives in `apps/api/src/services/calendar/connect-state.ts` — this is
the shipped Apiroc implementation now, not a Cronofy pattern being reused:

```typescript
// Format: base64url(payload).base64url(hmac). Payload = { expertProfileId, provider, nonce, ts }.
export function signConnectState(expertProfileId: string, provider: string): string {
  const secret = requireSecret(); // throws if INTERNAL_API_SECRET is unset
  const payload = {
    expertProfileId,
    provider,
    nonce: crypto.randomUUID(),
    ts: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

export function verifyConnectState(state: string): ConnectStatePayload {
  // split '.', re-derive the HMAC, crypto.timingSafeEqual after a length guard,
  // throw 'Invalid state signature' on mismatch, throw 'State has expired' past the 10-min TTL.
}
```

Rules:

- **`state` is the only identity input the callback may trust**, and only after
  `verifyConnectState` succeeds. It is HMAC-SHA256 over the base64url payload, compared with
  `crypto.timingSafeEqual` after a length guard (`timingSafeEqual` throws on a length mismatch —
  the guard is load-bearing, not decorative).
- TTL is **10 minutes** (`STATE_TTL_MS`). Expiry and signature failure are distinct user-facing
  error codes (`state_expired` vs `invalid_state`) so recovery copy can differ.
- The signing secret is `INTERNAL_API_SECRET` — the same secret `requireInternalAuth` uses. It is
  **not** an Apiroc credential and has nothing to do with `APIROC_API_KEY`.
- `readStatePayloadUnverified` parses the payload **without verifying the signature**, purely to
  put `&calendar_provider=…` on an error redirect or to know which provider's CSRF cookie to
  clear. That is fine **only** because both uses are cosmetic/best-effort. Never authorize, write,
  or look up on an unverified payload.

⚠⚠ **`state`'s `nonce` is bound to a short-lived CSRF cookie — this closes a real gap the HMAC
alone does not.** The HMAC + TTL on `state` proves Balo minted it for _some_ expert; it does not
prove the browser completing the callback is the one that started the flow. An attacker can mint
a connect URL for **their own** profile and hand it to a victim, whose consent then binds the
**victim's** calendar to the **attacker's** expert profile. Binding `nonce` to a cookie set at
connect-time closes it: an attacker's browser never holds the victim's cookie.

The cookie's name and `Domain` derivation are the **single shared source**
`packages/shared/src/calendar/connect-cookie.ts` (`@balo/shared/calendar`), imported by both
sides — this replaced an earlier hand-duplicated version that disagreed on `localhost` handling
and silently broke the whole binding in one env-var configuration. Its shape:

| Attribute  | Value                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name       | `balo_calendar_connect_nonce_google` / `..._microsoft` — scoped per provider, so an in-flight Google connect and a subsequently-started Microsoft connect cannot clobber each other's nonce               |
| `HttpOnly` | always                                                                                                                                                                                                    |
| `Secure`   | only when `NODE_ENV === 'production'`                                                                                                                                                                     |
| `SameSite` | `Lax`                                                                                                                                                                                                     |
| `Path`     | `/`                                                                                                                                                                                                       |
| `Max-Age`  | 600s (10 minutes) — matches `STATE_TTL_MS`                                                                                                                                                                |
| `Domain`   | `calendarConnectCookieDomain()` — the hostname of `APP_URL` (falling back to `NEXT_PUBLIC_APP_URL` on apps/web only), excluding `localhost` so local dev gets a host-only cookie on each app's own origin |

Lifecycle: `apps/web`'s `initiateCalendarConnectAction` sets the cookie (per provider)
**immediately** after `POST /api/calendar/connect` returns `{ authUrl, nonce }`, before handing
`authUrl` to the browser to navigate to. The callback (`GET /auth/apiroc/callback`) reads it via
`extractCookieValue` (a `split`/`indexOf` parser, deliberately not a regex — SonarCloud S5852) and
compares it to `state`'s `nonce` **before** persisting anything (§3.2). **Every branch of the
callback clears the relevant cookie(s)** — the matching provider's slot when one is known, every
provider's slot otherwise — via `Set-Cookie: …; Max-Age=0`, which is what gives the nonce
single-use semantics: there is no server-side nonce store, so a second hit of the same callback
URL by the same browser fails the CSRF check because the browser no longer holds the cookie, not
because anything was recorded as "spent." The docblock in `connect-state.ts` says this explicitly:
the `nonce` is **not** a replay guard by itself — the HMAC plus the TTL is the actual CSRF guard;
the cookie only proves _this browser_, not _this request only_, started the flow.

### 2.3 `externalId` is not identity

`externalId` is "external identifier from your system" **[stat]**, surfaced on `EndUserAccount`
as `externalId?: string | null`. Setting it to `expertProfileId` is worth doing for vendor-side
debugging. It is **not** an identity or uniqueness lever:

- Apiroc keys an End User Account on **(app, provider, email)** — reconnect returns the **same**
  account id **[live]**, so `externalId` does not partition two Balo experts who connect the same
  provider account.
- The success callback observed in the spike carried `endUserAccountId` and `state` **[live]** —
  **`externalId` was not echoed back.** The shipped `callbackQuerySchema` in `routes/calendar/auth.ts`
  confirms this by construction: its only fields are `endUserAccountId`, `state`, `error`,
  `error_description` — there is nowhere to read `externalId` from even if a handler wanted to.

### 2.4 `redirectUrl` allowlisting

`redirectUrl` must be registered in the Apiroc dashboard under **Application Details → Authorized
Redirect URIs** **[live]**. `http://localhost:8787/callback` was accepted there — **plain HTTP on
localhost is not rejected for OAuth**, so connect-flow work needs no tunnel. (Webhook `webhookUrl`
is the opposite: HTTPS required **[docs + stat]** — that is BAL-468's problem, not this one.)
Balo's env var is `APIROC_REDIRECT_URI`, read (and validated with a named `ApirocConfigError`
throw, never a silent `!`) by `apps/api/src/lib/apiroc/oauth.ts::buildApirocAuthorizeUrl` —
`apps/api/src/lib/apiroc/client.ts` deliberately does **not** read it or `APIROC_APP_ID`, only
`APIROC_API_KEY`, because the client singleton is the SDK-call boundary and the connect flow's
own concerns belong with the connect flow.

---

## 3. The callback handler

### 3.1 Three shapes, and `error` is checked FIRST

| Shape                                                                                | Meaning                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `?endUserAccountId=<id>&state=<state>` **[live]**                                    | Success. The param is literally `endUserAccountId`; `state` is intact. |
| `?provider=GOOGLE&error=missing_required_permissions&error_description=…` **[live]** | Partial consent. **No account was created. Persist nothing.**          |
| neither                                                                              | Must not crash. Redirect to a generic recovery state.                  |

Branch on `error` **first**, before touching `endUserAccountId`. A handler written for the happy
shape either throws on a missing param or — worse — persists `undefined` as a live pointer. The
shipped `callbackQuerySchema` (`routes/calendar/auth.ts`) makes every one of these fields
`.optional()`, matching this reality exactly rather than assuming any of them are present:

```typescript
const callbackQuerySchema = z.object({
  endUserAccountId: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
```

⚠⚠ **The captured error callback carried `provider`, `error`, and `error_description` — and no
`state` [live].** `state` does not survive onto the error branch. Treat expert identity as
**unknown** on that branch: render recovery from the authenticated web session (the expert is
signed in — they just came from `/expert/settings`), never from an unverified query param, and do
not write to `calendar_connections` at all.

`missing_required_permissions` is the **only** snake_case, genuinely enumerable error vocabulary
Apiroc emits. It appears on the OAuth callback query string and nowhere else — the wire `error`
field on API responses is a `string | number | object` union and must never be read as an enum
(see SKILL.md → "Error Handling").

### 3.2 The shipped handler

`apps/api/src/routes/calendar/auth.ts`. Two routes:

- `POST /api/calendar/connect`, `preHandler: [requireInternalAuth]`, body
  `{ expertProfileId: uuid, provider: 'google' | 'microsoft' }` → `{ authUrl, nonce }`. Signs
  `state` via `signConnectState`, then **immediately re-verifies its own freshly-signed state**
  purely to extract `nonce` — cheap, never expired, never tampered, so this is an extraction, not
  a trust boundary. Called from the web Server Action `initiateCalendarConnectAction` (§2.2),
  never from the browser directly. `apps/web` binds `nonce` to the per-provider CSRF cookie
  **before** handing `authUrl` back to the browser.
- `GET /auth/apiroc/callback` — **unauthenticated by necessity** (the provider redirects the
  browser here), so `state` plus the CSRF cookie carry all the trust.

`ctx.webAppUrl` reads **`APP_URL`**, not `WEB_APP_URL` — that variable is undocumented and unset
in production; `APP_URL` is the one every other user-facing link already uses. The callback
branches on the three shapes from §3.1, in order:

**Shape 1 — `error` present** (`handleCallbackErrorShape`): classifies via `classifyCallbackError`
(matches `error`/`error_description`, case-insensitively, against `PARTIAL_GRANT_MARKERS`
(`missing_required_permissions`) and `O365_ADMIN_MARKERS` (`access_denied`, `consent_required`,
`admin_approval` — Microsoft/AAD vocabulary carried over from the Cronofy handler, **plausible but
still unverified against a live Apiroc Microsoft callback**), else `callback_failed` and a `warn`
log so the real vocabulary is learned from production rather than guessed at again. Extracts
`{ expertProfileId, provider }` from `state` via `readStatePayloadUnverified` (unverified, since
the signature may be expired or tampered — never trusted for anything beyond labelling the
redirect and picking which cookie slot to clear), narrows `provider` through
`toCalendarEventProvider` before it ever reaches a redirect `Location` header, clears the matching
(or every) CSRF cookie, fires `trackServer(OAUTH_FAILED, { error_code, provider?, distinct_id })`,
and redirects with `calendar_error=<code>&calendar_provider=<provider>`.

**Shape 2 — `endUserAccountId` + `state` present** (`handleEndUserAccountIdShape`):

1. `verifyConnectState(state)` — throws on a bad signature or expired TTL →
   `handleInvalidState`: classify `state_expired` vs `invalid_state` from the thrown message,
   `warn`-log, clear the cookie for whatever provider the **unverified** payload names (same
   best-effort extraction as Shape 1, for the same reason — the signature itself failed, so
   nothing from this state is trustworthy yet), redirect.
2. `state` verified — `provider` is now trustworthy (it came out of a
   `z.enum(['google', 'microsoft'])`-validated connect body before ever being signed), still
   narrowed through `toCalendarEventProvider` defensively since the DB column itself carries no
   CHECK. Clear **this** provider's cookie now.
3. **The CSRF binding check** (`handleCsrfMismatch` on failure): read the cookie named for this
   provider, compare it to `state`'s `nonce`. Missing or mismatched → `warn`-log
   `apiroc_callback_csrf_nonce_mismatch`, `trackServer(OAUTH_FAILED, { error_code:
'state_csrf_mismatch', ... })`, redirect with that error code. **Never a 500, and nothing is
   persisted.**
4. Match → `persistAndRedirectConnected`: `persistApirocConnection` (the pointer upsert, §4.1) →
   `provisionConnection` (list calendars, choose the target, set `credentialStatus`, §1.4/§5.1) →
   `enqueueAvailabilityCacheRebuild` → `trackServer(OAUTH_COMPLETED, { provider, status:
legacyStatus, distinct_id })` where `legacyStatus` is the plain ternary
   `status === 'ACTIVE' ? 'connected' : 'sync_pending'` (exhaustive: `provisionConnection` only
   ever returns those two) → redirect
   `…&calendar_connected=true&calendar_status=<legacyStatus>&calendar_provider=<provider>`. A
   failure **after** the connection row already exists still redirects (never a 500) with
   `calendar_error=callback_failed&calendar_provider=<provider>` — retrying from this same
   response would fail the now-consumed CSRF check rather than proceeding cleanly, so failing loud
   here (with a `log.error`) matters.

**Shape 3 — neither** (`request.query` fails `callbackQuerySchema`, or parses to an object with
none of `error`/`endUserAccountId`): `warn`-log, clear every provider's cookie (no trustworthy
provider signal exists in this shape), redirect `calendar_error=invalid_callback`.

⚠ `OAUTH_COMPLETED`'s `status` prop stays typed `'connected' | 'sync_pending'` in
`packages/analytics/src/events/calendar.ts` and needs **no widening** — the callback's own ternary
can only ever produce one of those two values, so the map already covers every reachable case.

### 3.3 Partial consent — the vendor closes the hole, you handle the shape

Google's consent screen has **granular per-scope checkboxes, every one unchecked by default,
including "Select all"**. Completing the flow with nothing ticked produces the error callback
above: Apiroc validates scope grants server-side and **creates no account** **[live]**. So Balo
cannot end up holding a live pointer to a calendar it cannot read — the half-connected-account
risk is mitigated **by the vendor**, not by us. What is left for us is exactly one obligation:
**handle the error shape, and write nothing on it.**

Pinned by test: `routes/calendar/auth.test.ts` asserts a `missing_required_permissions` callback
redirects with `calendar_error=partial_grant` and (separately) that a malformed/garbage `state`
alongside that error never throws and never persists a row.

---

## 4. What gets persisted, and what must never be

### 4.1 The pointer model

A connection persists **`end_user_account_id` + `provider` + `expert_profile_id`**, plus the
derived `target_calendar_id` and display `provider_email`. That is the whole record. Balo stores
**no provider access token, no refresh token, and no token expiry** — migration `0069` removed the
columns that used to hold them (Cronofy's), and Apiroc never gave Balo a reason to add equivalents:
the vendor refreshes provider tokens itself.

⚠ **`endUserAccounts.getCredentials(id)` DOES return raw provider tokens.** `EndUserAccountCredential`
exposes `accessToken`, `refreshToken`, and (Apple) `password` **[stat]**. The "we never hold
tokens" posture is **a choice Balo keeps making, not something the API enforces** — and, as of
BAL-396, a choice enforced by the schema itself (there is no column left to put one in).
Consequences:

- Prefer `endUserAccounts.get(id)` — it returns `{ id, email, externalId, providerAccountId,
providerType, applicationId, authorizedScopes?, status, createdAt, updatedAt }` **[stat]** and no
  secrets — whenever the status or account metadata is all you need. This is exactly what
  `confirmNonActiveStatus` (`services/calendar/credential-status.ts`) uses to decide `EXPIRED` vs
  `REVOKED`.
- If `getCredentials` is ever called, the credential object must never be logged, never be
  serialised into an error, and never touch a column. The BAL-393 capture scrubber strips
  `accessToken` / `refreshToken` / `password` / `endpointSecret` at any depth including inside
  raw-body **strings** — the same hazard applies to production logging.
- `ApirocError.wireErrorRaw` (`apps/api/src/lib/apiroc/errors.ts`) is defined with
  `enumerable: false` precisely so Pino's default `err` serializer cannot copy a raw wire body
  into Axiom. Do not re-assign it as a plain property.

### 4.2 No calendar-specific encryption module ships — and none is needed today

⚠⚠ **`apps/api/src/lib/calendar-encryption.ts` no longer exists — BAL-396 deleted it.** It was
real: it shipped with the Cronofy OAuth backend (BAL-232, PR #72) and existed on this branch's
parent. This PR removed it (54 deletions in the BAL-396 commit) together with the Cronofy token
columns it protected (`access_token`, `refresh_token` — migration 0069), because the Apiroc model
stores a pointer and no tokens. Its only importers were the two Cronofy service files, which went
in the same commit; nothing imports it now. Do not write code that imports
`calendar-encryption.ts` or assumes `encryptCalendarToken`/`decryptCalendarToken` exist, and do
not read its absence as evidence that calendar secrets were never encrypted — they were, until
there stopped being any to encrypt.

Nothing calendar-related needs encrypting today: `end_user_account_id` is a pointer, not a secret
(store it plaintext, per §4.1); the signed OAuth `state` is HMAC-signed, not encrypted (§2.2); and
there is no `endpoint_secret` column because `calendar_subscriptions` (§1.5) does not exist yet.

If BAL-468 introduces `endpoint_secret` for webhook subscriptions, the reuse target is the
**payout-encryption precedent already in the codebase** — `apps/api/src/lib/encryption.ts`
(`decryptValue`), paired with `apps/web`'s `encryptValue` (used today for Airwallex payout
details): AES-256-GCM, key = bare SHA-256 of an env var (no KDF salt), output format
`iv:authTag:ciphertext` (all base64), 12-byte random IV per call. Do not invent a second scheme,
and do not resurrect a `calendar-encryption.ts` file — follow the one pairing that already exists.
This is **intended shape**, attributed to BAL-468, not something built.

---

## 5. Credential status and reconnect

### 5.1 One status vocabulary now, not two out of sync

| Vocabulary                                                   | Values                                               | Where                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Vendor `EndUserAccountCredentialStatus`                      | `ACTIVE` \| `EXPIRED` \| `REVOKED` **[stat]**        | Returned by `endUserAccounts.get()` / `.getCredentials()`                |
| **Balo `calendar_connections.credential_status`** (as built) | `ACTIVE` \| `SYNC_PENDING` \| `EXPIRED` \| `REVOKED` | Enforced by CHECK `cal_conn_credential_status_check`, default `'ACTIVE'` |

✅ **This used to be a warning about drift; it no longer is.** Migration `0068` renamed `status` to
`credential_status` and swapped the CHECK vocabulary from the Cronofy shape
(`connected|sync_pending|auth_error`) to the vendor-mirroring one. Writing `'ACTIVE'` is now
literally the column's **default** — it is `'connected'` that would fail. Three of the four values
mirror the vendor enum exactly; `SYNC_PENDING` is **Balo-side only**, with no vendor counterpart:
it means "the credential is live at Apiroc but Balo has not finished first provisioning (no
sub-calendar rows / no target calendar yet)." A `SYNC_PENDING` connection is UNREADABLE for
free/busy — `listBusyReadTargets` (§1.4) still returns it (deliberately, so the caller can tell
"cannot check" from "nothing to check"), and the booking gate must fail **closed** on it, never
treat it as "no calendar."

`.$type<CalendarCredentialStatus>()` on the column is **load-bearing, not documentation**: it
makes `eq(calendarConnections.credentialStatus, 'connected')` a compile error rather than a query
that silently matches zero rows forever. `findStaleConnections`' docblock in
`repositories/calendar.ts` names exactly this failure mode as the reason.

⚠ **The `updateConnectionStatus` fan-out is gone, not merely deprecated** (§1.4) — replaced by
`setCredentialStatusForProvider` (provider-scoped) and `setCredentialStatus` (connection-keyed).
One provider's `EXPIRED` can no longer brand the other provider's row.

⚠ The **old Cronofy vocabulary still exists in exactly one place**:
`routes/calendar/api.ts::toLegacyStatus`, a presentation-only adapter
(`ACTIVE→'connected'`, `SYNC_PENDING→'sync_pending'`, `EXPIRED`/`REVOKED→'auth_error'`, collapsed —
no distinct UX) for `apps/web`'s pre-BAL-397 single-connection settings card. It is explicitly
documented to die with BAL-397, and it is the **only** place the two vocabularies still meet.

Also **[stat]**: `endUserAccounts.list({ statusFilter })` accepts only `'active' | 'expired'` —
only two of the three vendor values are filterable, which lines up with `REVOKED` looking
unreachable in practice on Google **[live]**.

### 5.2 Detection is error-driven, never status-driven — and this is now the shipped discriminator

The full evidence table is in SKILL.md → "Credential expiry & reconnect detection"; do not
duplicate it. The vendor facts, unchanged:

1. **The status flip is lazy and event-based.** After the user revokes at the provider,
   `endUserAccounts.get()` still says `ACTIVE` and `getCredentials()` still returns **both tokens**
   **[live]**. It flips to `EXPIRED` only once a real data call has already failed. Polling status
   is a _lagging_ record of a failure you have already seen.
2. **A user-initiated revoke surfaces as `EXPIRED`, not `REVOKED`.** No distinct UX for the two;
   any non-`ACTIVE` value means "reconnect required."
3. **The same condition yields different HTTP statuses depending on timing** — pre-flip
   `401 InvalidRefreshToken`, post-flip `403 "End user account credential expired"`.
4. **No proactive signal exists.** `enduseraccount.credential.updated` never fired across 5.5
   minutes spanning both the revoke and the status flip, with a live `event` subscription in place
   **[live]**.

⚠⚠ **A 401 does not mean "bad API key" — and this is now a real, shipped discriminator, not
guidance.** Through the SDK a revoked expert credential and a bad platform API key throw the
**same class and the same code** (`AuthenticationError` / `AUTHENTICATION_ERROR`). Separating them
is `apps/api/src/lib/apiroc/reconnect.ts::classifyCredentialFailure`, matched against
`wireMessage`:

| `err.kind`                                  | `wireMessage`             | Verdict                             |
| ------------------------------------------- | ------------------------- | ----------------------------------- |
| `unauthorized` (401)                        | contains an expert marker | `reconnect_required`                |
| `unauthorized` (401)                        | no marker, or **absent**  | `platform_auth_failure`             |
| `forbidden` (403)                           | contains an expert marker | `reconnect_required`                |
| `forbidden` (403)                           | no marker, or absent      | `other` (log loudly; touch nothing) |
| `rate_limited` / `server_error` / `network` | —                         | `transient`                         |
| `validation` / `not_found` / `unknown`      | —                         | `other`                             |

Expert markers (`EXPERT_CREDENTIAL_MARKERS`, matched case-insensitively): `'expired or revoked'`,
`'credential expired'`, `'invalid refresh token'` — the exact wire messages the credential-expiry
table observed **[live]**. ⚠ **Absent `wireMessage` ⇒ platform, never expert, on purpose.** The
capture can be lost (the interceptor degrades gracefully if the SDK's shape changes), and the
asymmetry decides the default: a wrong "integration is down" alert wakes an engineer; a wrong
"reconnect required" emails an expert instructions they cannot act on, with no un-send. This
positively matches the expert arm and treats everything else — including a recognised-but-unmarked
403 — as **not** the expert's fault.

`services/calendar/credential-status.ts::applyCredentialFailure` is **the one place a credential is
marked broken** — provider-agnostic (no provider literal, no `provider ===` form —
`invariants/sync-token-parity.test.ts` Scan B):

- `reconnect_required` → `flipToReconnectRequired`: re-reads `endUserAccounts.get()` to decide
  `EXPIRED` vs `REVOKED` (`confirmNonActiveStatus` — a failed re-read still resolves to `EXPIRED`,
  never aborts the flip, since the data-call failure that got here already **is** the evidence),
  writes `setCredentialStatus`, `clearAvailabilityCache`, `log.warn`s a structured
  `apiroc_credential_reconnect_required` record (always-on, unlike the PostHog call which no-ops
  without `POSTHOG_API_KEY`), notifies **at most once per breakage** via
  `notificationEvents.publish('calendar.auth_error', ...)` gated on `reconnectNotifiedAt === null`
  and stamped **after** the publish succeeds (never before — a failed publish must retry, not go
  silent forever), and fires `trackServer(CREDENTIALS_REVOKED, { provider, detected_by:
'health_probe', distinct_id })`.
- `platform_auth_failure` → `log.error` only (`apiroc_platform_auth_failure`) — no status write,
  no notification. This is a Balo-side ops alert, not an expert-facing one.
- `transient` / `other` → `log.warn` only, row left alone.

⚠ `detectedBy` is typed `'health_probe'` **only**, as shipped — `applyCredentialFailure`'s only
production caller is the health probe (§5.3); there is no booking-path caller catching an
`ApirocError` directly yet. Widen the type back to `'health_probe' | 'data_call'` the same PR that
adds one — not before, or the "probe-detected vs booking-detected" metric becomes uncomputable
again (this exact trap already happened once and was reverted — see the docblock in
`credential-status.ts`).

### 5.3 The health probe — BAL-396 §9/§10.5, **built and live**

⚠ **This section used to say "not built." It is now the platform's only proactive
calendar-breakage signal**, shipped in `apps/api/src/jobs/calendar-health-probe.ts`. Every other
Apiroc call site is reactive — it discovers a broken credential only when a booking or a sync
happens to touch it. This sweep finds a dead credential **before** a client ever hits it.

- **Cadence**: a repeatable BullMQ job on cron `*/15 * * * *` (every 15 minutes) —
  `registerCalendarHealthProbeCron`. Each connection is only actually probed at most once per
  `PROBE_INTERVAL_MS` (1 hour) — a per-connection throttle layered on top of the 15-minute tick.
  ⚠⚠ `PROBE_INTERVAL_MS` **must** stay strictly greater than `jobs/availability-cache.ts`'s
  `STALENESS_CHECK_THRESHOLD_MS`, enforced by a throw **at module load** (not at some runtime path
  that might never execute) — lowering it to or below that threshold silently makes
  `findStaleConnections` (§1.1/§1.4) return `[]` forever, in a completely different file.
- **The probe call**: `calendars.list(endUserAccountId, { pageSize: 1 })` — the cheapest real
  **data** call there is. **Never** `endUserAccounts.get()`; status polling provably cannot detect
  a revoke (§5.2, point 1).
- **Serial, batch-bounded**: `concurrency: 1`, a plain `for` loop over the batch (house precedent —
  every job in `jobs/` does this). At most one Apiroc request is ever in flight; growth stretches
  coverage (whether every live connection is proven within its interval), not burst.
  `CALENDAR_HEALTH_PROBE_BATCH_LIMIT = 100`; a filled batch **warns** loudly
  (`apiroc_health_probe_batch_filled`) rather than silently capping (house precedent:
  `MEETING_LIFECYCLE_BATCH_LIMIT`).
- **The heal path runs in the same sweep** (`probeAndHeal`): a successful data call
  `markCredentialChecked`s the connection, then:
  - if `SYNC_PENDING`, or `ACTIVE` with **zero** sub-calendar rows (a past provisioning that
    succeeded with nothing writable — an absorbing, permanently-unbookable state if left alone) —
    re-run `provisionConnection`. `SYNC_PENDING_AUTO_RESOLVED` fires only when the connection was
    genuinely `SYNC_PENDING` before; the never-`SYNC_PENDING`-but-zero-calendars case gets its own
    honestly-named log line instead of misusing that metric.
  - if already `ACTIVE` and provisioned, nothing to heal.
  - if `EXPIRED`/`REVOKED` and the data call just succeeded, the expert reconnected out of band:
    flip to `ACTIVE` (which also clears `reconnectNotifiedAt`), rebuild the availability cache,
    fire `RECONNECT_RESOLVED`.
- **The mass-failure circuit breaker is the point of the file.** A platform-key fault or a
  vendor-wide outage can produce marker-bearing 401/403s for **every** connection in one tick —
  misclassifying "the integration is down" as "every expert must reconnect" would email every
  connected expert at once, with no un-send. So every classified failure is **deferred**
  (`probeCandidate` never writes status), and only after the whole batch is seen does
  `evaluateMassFailure` decide: the breaker trips when the reconnect-required count reaches
  `max(5, 50% of candidateCount)`, **or** — independently, since the ratio check is blind on a
  small fleet — when **every** candidate in a batch of at least 2 is reconnect-required
  (`MASS_FAILURE_UNIFORM_MIN_SAMPLE = 2`; a single-connection batch is excluded on purpose, since
  one expert revoking access is an ordinary event that must still flip every tick). Tripped → no
  reconnect-required verdict is flipped, nobody is notified, only a loud
  `apiroc_probe_mass_failure_suspected` log; non-reconnect verdicts (`platform_auth_failure` /
  `transient` / `other`) still route through `applyCredentialFailure` regardless of the breaker,
  since those branches never flip status or notify anyway.
- **Result shape**, logged every tick (`apiroc_health_probe_completed`): `probed`, `failed`
  (reconnect-required verdicts actually applied), `unclassifiedFailed` (routed through
  `applyCredentialFailure` but never flipped status — this is what keeps a mass platform-key
  outage from logging `failed: 0` and reading as a healthy sweep), `recovered`, `batchFilled`,
  `massFailureSuspected`.

Test coverage: `jobs/calendar-health-probe.test.ts` drives `runCalendarHealthProbe` directly
(exported specifically so it can be unit-tested without a Redis-backed `Worker`).

### 5.4 Reconnect ORDERING — reconnect FIRST

**reconnect → delete stale subscriptions → re-create.** Never delete first. This remains
**BAL-468's** problem in practice — `calendar_subscriptions` does not exist yet (§1.5), so there is
no subscription to delete or re-create today — but the vendor evidence and the ordering rule are
unchanged and still the reason a future subscription-lifecycle implementation must not delete
before reconnecting:

Deleting a subscription while the credential is `EXPIRED` returns
`403 "End user account credential expired"` **[live]** — and the credential is expired precisely
_because_ the user revoked, which is the reason you are reconnecting. A delete-then-recreate
procedure is therefore **unexecutable**: at cleanup time the delete is already forbidden.

Reconnect-first works because **`endUserAccountId` is stable across a revoke/reconnect cycle**
**[live]**: the callback returned the same id, the account's `createdAt` was unchanged and
`updatedAt` moved. Apiroc keys the account on (app, provider, email), so reconnect is an UPDATE on
the vendor side, not an INSERT, and old subscription records would stay addressable afterwards.

⚠⚠ **The vendor pointer is stable; the Balo row id is not — and this is now proven, shipped
behaviour, not a hazard to design around.** `upsertApirocConnection`'s ON CONFLICT arbiter
(`target: [expertProfileId, provider]`, `targetWhere: isNull(deletedAt)`) means a
reconnect-after-_disconnect_ cannot match the soft-deleted row (it is invisible to the partial
index) and therefore **INSERTs a fresh `calendar_connections` row**, leaving the old one behind as
history. Anything keyed on `connection_id` — `calendar_sub_calendars` today, and BAL-468's
subscriptions table once it exists — must be re-created against the **new** row, never looked up
by the old one. `endUserAccountId` staying the same does **not** mean the Balo row did. (A
reconnect that is **not** preceded by a disconnect — the connection is still live, just
credential-broken — goes through the same upsert's UPDATE arm instead, and the row id does _not_
churn; see `provisionConnection`'s "only default the target calendar when unset" rule in §3.2,
which exists specifically because that arm is a re-provision of an existing row, not a fresh one.)

⚠ Cleanup must be **verified, not best-effort**, once BAL-468 ships. A stale subscription keeps
delivering duplicate webhooks for up to 7 days (BAL-468 §4). Whether subscriptions survive a
reconnect at all is **still untested** — SKILL.md → "Still unverified."

---

## 6. The re-consent trap

⚠⚠ **A partial grant cannot be fixed by re-running consent.** Once the expert has granted
anything, Google collapses the consent screen to "already has some access" and **does not re-show
the per-scope checkboxes — even with `prompt=consent`** **[live]**. Sending them back through the
same flow returns them to exactly the state they were in. They loop.

The only recovery is: **revoke at `myaccount.google.com/permissions` first, then reconnect.**
Reconnect copy must say so explicitly, or the expert cannot get out. This is **BAL-462, and it is
still not built** — the shipped `apps/web` calendar settings tab
(`_components/calendar-tab.tsx`) has a plain "reconnect" action wired to
`initiateCalendarConnectAction` and a generic toast on connection loss, but not the specific
revoke-first explainer copy below. The design reference is
`.claude/design-references/google-calendar-consent-explainer.jsx` (three states: pre-consent
explainer, partial grant, reconnect) and still exists unimplemented on this branch.

Copy, from that reference — all gender-neutral, warm, non-adversarial (CLAUDE.md):

| State         | Copy                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-consent   | "Tick both boxes, then choose Continue." Plus an honest sees / never-sees ledger: Balo reads **when** you're free or busy, never **what** is in your events, and only writes the consultations you book.                                                                                                                                                                |
| Partial grant | "**Calendar access wasn't granted.** Google needs both boxes ticked before Balo can see your free times. Nothing was saved — Balo didn't read anything." → _Try again_ / _Do this later_                                                                                                                                                                                |
| Reconnect     | "**Reconnect your Google Calendar.** You've connected before, so Google won't show the permission boxes again. Two quick steps: 1. Remove Balo's access in your Google Account — listed as "Balo"; this clears the partial grant. 2. Come back and reconnect — this time, tick both boxes before Continue." → _Open Google permissions_ / _I've removed it — reconnect_ |

Copy rules that fall out of this:

- Say "Balo only reads…", never "Balo can't read…". It is a promise about **use**, not a claim
  about what the token could technically do. Do not overclaim.
- Never a gendered pronoun. Address the expert as "you"; name parties (the client company, the
  agency) in prospective copy and the person in retrospective copy.
- Never absence-framed. "Calendar access wasn't granted" + the fix, not "No calendar connected".
- **Google-scoped on purpose.** Microsoft's consent has no unchecked-by-default failure mode, so
  the Microsoft connect flow gets a lighter interstitial or none. Do not generalise this screen.

⚠ Ticket drift to be aware of: the design reference cites its backend half as **BAL-456** and
parent **BAL-397**, and the scope question as **BAL-457**; SKILL.md's "Where the rules live" table
names **BAL-462** for the copy and **BAL-394** for OAuth app registration and scopes. Confirm the
live ticket in Linear before quoting a number in a PR description.

---

## 7. Disconnect

### 7.1 As built — per-provider, and vendor-side deletion now happens

⚠ **This section used to describe an inconsistent Cronofy whole-account path and defer the
per-provider question to "BAL-396." That ticket is this branch — per-provider disconnect is now
real, and so is calling `endUserAccounts.delete()`.**

`POST /api/calendar/disconnect` (`routes/calendar/api.ts`), body
`{ expertProfileId, provider? }`:

- **`provider` present** → `disconnectProvider(expertProfileId, provider)` only. That provider's
  connection is removed; the expert's other live connection (if any) is untouched.
- **`provider` absent** → today's whole-account behaviour, and what the "Disconnect all
  calendars" copy says: loop `disconnectProvider` over every live connection
  (`listConnectionsByExpertProfileId`), **then** call `softDeleteConnection` (the fan-out) as a
  defensive backstop for anything the per-provider loop did not enumerate — not a real code path
  today (migration `0069` already removed every Cronofy-era row at the DB level), but cheap
  insurance.

Either way, the route then **enqueues** an availability-cache **rebuild** (never a clear) —
`enqueueAvailabilityCacheRebuild` — because with two providers connected, disconnecting one must
recompute from the remaining one, not blank the cache outright. It fires
`trackServer(DISCONNECTED, { provider?, distinct_id })` (provider absent on the whole-account
path).

`disconnectProvider` (`services/calendar/apiroc-connection.ts`), in order:

1. Look up the (expert, provider) connection via `findConnectionByExpertAndProvider`. No row → no-op.
2. **Best-effort vendor deletion, ordered first**: `callApiroc('endUserAccounts.delete', () =>
client.endUserAccounts.delete(connection.endUserAccountId))`, wrapped in try/catch — a failure
   `log.warn`s (`apiroc_disconnect_vendor_delete_failed`) and continues. If the vendor call fails,
   Balo's side is still removed; leaving a row the expert asked to disconnect is the worse failure.
3. `deleteSubCalendarsByConnectionId(connection.id)` — **hard delete**, scoped to **this**
   connection only (not the expert-wide fan-out the Cronofy path used to run).
4. `softDeleteConnectionForProvider(expertProfileId, provider)` — soft-deletes **only** this
   provider's row.

There is no null guard on `endUserAccountId` here — migration `0069` made the column `NOT NULL`,
so every connection this function can find already carries a pointer and the vendor call always
runs.

⚠⚠ **SUSPECTED GAP — see the report for escalation.** `disconnectProvider`'s vendor-side
`endUserAccounts.delete()` call does not check `findConnectionsByEndUserAccountId` for **other**
Balo `calendar_connections` rows sharing the same `endUserAccountId` before deleting the vendor
account. §1.1 documents that this is a routine, expected situation (two Balo experts connecting
the same Google account, in dev/seed data and in principle in production) precisely because
`cal_conn_end_user_account_idx` is non-unique. If two experts ever do share one vendor account and
one of them disconnects, the vendor-side delete would remove the account the **other** expert's
still-live row still points to — silently, since the vendor call is best-effort and any failure
there is merely logged, but a **success** here removes an account another live row depends on with
no cleanup of that row at all. No test in `apiroc-connection.test.ts` exercises this scenario.

**Not built, and no longer an open design question — subscription cleanup**: once BAL-468 ships
`calendar_subscriptions`, per-provider disconnect must delete that connection's webhook
subscriptions **before** soft-deleting the row, verified rather than best-effort. There is no such
step today because there is no such table today (§1.5).

---

## 8. Checklist — adding or changing a connection path

- [ ] **Provider-scoped, not expert-scoped.** Every read and write names `provider`. If you
      reached for `findConnectionByExpertProfileId` / `softDeleteConnection` (the fan-out), justify
      it or switch to the `…ForProvider`/provider-scoped sibling. `updateConnectionStatus` and the
      expert-wide `updateTargetCalendarId` no longer exist to reach for at all — they were deleted.
- [ ] **Lowercase in the DB, uppercase at the SDK.** `'google'`/`'microsoft'` in every column,
      zod schema, and analytics prop; `'GOOGLE'`/`'MICROSOFT'` only inside `oauth.ts`'s
      `toApirocProviderType` / the `getOAuthUrl` call.
- [ ] **Any new upsert keeps `target: [expertProfileId, provider]` + `targetWhere: isNull(deletedAt)`.**
      Omitting `targetWhere` is 42P10 at plan time with every local gate green.
- [ ] **`state` is non-empty and signed** before `getOAuthUrl` — a falsy `state` is silently
      dropped by the SDK **[stat]**, leaving the flow with no CSRF token. `signConnectState`
      already guards this by construction; do not build a second state-minting path that skips it.
- [ ] **The CSRF-binding cookie is set (per provider) before the browser ever leaves for the
      vendor**, and read/compared/cleared on every callback branch — never assume `state`'s HMAC
      alone is sufficient (§2.2/§3.2).
- [ ] **Callback branches on `error` first**, handles all three shapes, and writes **nothing** on
      the error or empty branch. Do not assume `state` is present on the error branch **[live]**.
- [ ] **No provider tokens persisted, ever**, and no `getCredentials()` result logged, serialised,
      or stored. Prefer `endUserAccounts.get()`. There is no `calendar-encryption.ts` to reach for
      — if you think you need to encrypt a calendar-related secret, re-read §4.2 first.
- [ ] **Status writes use the shipped `ACTIVE|SYNC_PENDING|EXPIRED|REVOKED` vocabulary** — the
      CHECK now **rejects** the old Cronofy words (`connected`/`sync_pending`/`auth_error`); those
      only exist any more in `api.ts::toLegacyStatus`'s presentation adapter, which dies with
      BAL-397.
- [ ] **Reconnect detection is error-driven**: run failures through
      `classifyCredentialFailure` (`lib/apiroc/reconnect.ts`) and `applyCredentialFailure`
      (`services/calendar/credential-status.ts`) — the one place a credential is marked broken.
      Never poll status as a leading indicator, and never hand-roll a second discriminator between
      an expert-side revoke and a platform-key fault.
- [ ] **Reconnect order is reconnect → delete → recreate.** Re-create anything keyed on
      `connection_id`; the Balo row id changed even though `endUserAccountId` did not, on a
      reconnect that follows a disconnect (§5.4).
- [ ] **Every SDK call goes through `callApiroc('operation', () => …)`**, one call per wrapper.
      Never consume the SDK's thrown error directly; never branch on the wire `error` field or
      `error.constructor.name`.
- [ ] **A per-provider disconnect that calls vendor deletion should consider whether the
      `endUserAccountId` is shared with another live Balo connection first** — the shipped
      `disconnectProvider` does not (§7.1); do not copy that gap into new code without at least
      flagging it the way this file now does.
- [ ] **Reconnect copy names the provider-side revoke step** and is gender-neutral, warm, and
      never absence-framed.
- [ ] **Tests:** any new file in `packages/db/src/repositories/` needs an
      `*.integration.test.ts` in the same PR; the 42P10 and 23502 arms are only visible on real
      Postgres. Add a case pinning _partial-grant callback creates no row_.
- [ ] **Notifications** go through `notificationEvents.publish()`. Feature code never sends email.
- [ ] Ran `pnpm typecheck` (root, both task names) and `pnpm lint --force` — turbo replays stale
      PASSes across worktrees.

---

## Cross-references

| For                                                                   | Read                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Why the credential status lies; the full revoke evidence table        | SKILL.md → "Credential expiry & reconnect detection"                        |
| The SDK's error envelopes, five defects, and retry policy             | SKILL.md → "Error Handling"                                                 |
| What was refuted and why the first skill version was wrong            | SKILL.md → "Hypothesis ledger"                                              |
| Provider semantic divergences (ids, tags, sync tokens)                | SKILL.md → "Provider-parity table", M1–M3                                   |
| Subscription creation, the 7-day expiry, renewal (BAL-468, not built) | SKILL.md → "Subscriptions & lifecycle"                                      |
| Raw captured evidence                                                 | `spikes/apiroc-probe/FINDINGS.md` on the BAL-393 branch (PR #211, unmerged) |
