# Apiroc connection lifecycle — connect, callback, credentials, reconnect, disconnect

Depth material for anyone writing or changing a connect / reconnect / disconnect path against
Apiroc. `SKILL.md` carries the _why_ (vendor behaviour, the provider-parity table, the
hypothesis ledger, the credential-expiry evidence); this file carries the _how_ — the shipped
`calendar_connections` shape, the exact state-signing and callback branching a handler must do,
what may and may not be persisted, and the ordering rules that make reconnect work. Read it
before touching `apps/api/src/routes/calendar/*`, `packages/db/src/schema/calendar.ts`, or
`packages/db/src/repositories/calendar.ts`. Evidence tags match SKILL.md: **[live]** observed
against the real API in the BAL-393 spike, **[stat]** read out of the published SDK bundle,
**[docs]** vendor docs only. Untagged prose is a Balo design rule.

⚠ **Nothing in this file is a live Apiroc code path yet.** BAL-467 (PR #219, merged) shipped the
per-provider table, the repository reads/writes, and the SDK adapter boundary — all **inert**.
The live connect/callback/disconnect code in `apps/api` is still **Cronofy**. BAL-396 writes the
Apiroc arm and deletes the Cronofy one. Where this file shows Cronofy code it says so, because
that code is the pattern the Apiroc arm reuses (signed state, redirect vocabulary, repository
call shape), not something to copy verbatim.

---

## 1. The connection model, as built

### 1.1 What shipped in `calendar_connections`

`packages/db/src/schema/calendar.ts`, migration `0067_bal467_apiroc_per_provider_connections.sql`.

| Column                                                             | Type                               | As-built truth                                                           |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------ |
| `id`                                                               | uuid pk                            | Balo row id. **Churns on reconnect** — see §5.4.                         |
| `expert_profile_id`                                                | uuid not null                      | FK → `expert_profiles.id`, `ON DELETE cascade`                           |
| `end_user_account_id`                                              | text **nullable**                  | The Apiroc pointer. Nullable because Cronofy rows leave it NULL          |
| `cronofy_sub`, `access_token`, `refresh_token`, `token_expires_at` | text / timestamp, **all nullable** | Cronofy-only; an Apiroc row leaves all four NULL. Die with BAL-396       |
| `provider`                                                         | text not null                      | `'google' \| 'microsoft'` **lowercase**, no CHECK on it                  |
| `provider_email`                                                   | text nullable                      | display only                                                             |
| `status`                                                           | text not null, `'connected'`       | ⚠ **still the Cronofy vocabulary** — see §5.1                            |
| `last_synced_at`, `channel_id`, `target_calendar_id`               |                                    | `channel_id` is Cronofy push; `target_calendar_id` is **per connection** |
| `...timestamps`, `...softDelete`                                   |                                    | `created_at`, `updated_at`, `deleted_at`                                 |

Indexes:

| Index                                                 | Shape                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `cal_conn_expert_provider_idx`                        | **UNIQUE** on `(expert_profile_id, provider)` **WHERE `deleted_at IS NULL`** |
| `cal_conn_end_user_account_idx`                       | non-unique on `end_user_account_id` WHERE `deleted_at IS NULL`               |
| `cal_conn_cronofy_sub_idx`, `cal_conn_channel_id_idx` | Cronofy-era, die with BAL-396                                                |
| `cal_conn_status_check` (CHECK)                       | `status IN ('connected','sync_pending','auth_error')`                        |

**A "connection" is one (expert, provider) pair.** One expert may hold a live Google connection
and a live Microsoft connection simultaneously; each is a distinct Apiroc End User Account and
its own row. Availability is the **union** of busy blocks across all of an expert's live
connections. Connect, disconnect, and reconnect are **per provider** (ADR-1021, amendment
18 Aug 2026 §1). The table is **dual-tenanted for one release**: a Cronofy row carries
`cronofy_sub` + three encrypted token columns and no `end_user_account_id`; an Apiroc row carries
`end_user_account_id` and none of the four. Making either arm `NOT NULL` makes the other
unwritable — that is why all five columns are nullable.

⚠ **SKILL.md's "DB Schema (Drizzle)" preamble is now stale on one point.** It says the shipped
`calendar_connections` is "unique on `expertProfileId` (one connection per expert)" and that the
migration to `(expertId, provider)` "is BAL-467 §1". BAL-467 **merged** (commit `eb6d4b2`): the
partial per-provider unique and `end_user_account_id` are live today. The rest of that warning
still holds — `status`, the four Cronofy columns, and `calendar_sub_calendars` are unchanged.

### 1.2 What the cardinality invariant forbids

`packages/db/src/invariants/calendar-connection-cardinality.test.ts` runs in the **unit** job
(no Docker) over live table metadata and repository source. It fails on four specific wrong
codes:

| Wrong code                                                                      | Why it is wrong                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Any index keyed on `expert_profile_id` **alone**, under any name                | Restores the one-connection-per-expert world the amendment repealed                                             |
| Dropping the unique index's `WHERE deleted_at IS NULL`                          | Disconnect soft-deletes → reconnect fails **23505** against a row the application cannot see                    |
| Moving `deleted_at` into the **key columns** instead                            | Looks equivalent, does the opposite: NULL ≠ NULL in a unique index → **unlimited live duplicates**              |
| An ON CONFLICT arbiter naming `expertProfileId` alone, or missing `targetWhere` | Arbiter inference fails **at plan time** → every upsert raises **42P10**, including the first on an empty table |

It also pins `schema/experts.ts` to `many(calendarConnections)` — a singular `one(...)` relation
names an arbitrary one of two live rows. Behavioural proof (two providers coexist, 23505 on a
duplicate, reconnect-after-disconnect) lives in `repositories/calendar.integration.test.ts` and
needs real Postgres.

### 1.3 The upsert arbiter — copy this exactly

```typescript
// packages/db/src/repositories/calendar.ts — calendarRepository.upsertConnection
await db
  .insert(calendarConnections)
  .values({ ... })
  .onConflictDoUpdate({
    target: [calendarConnections.expertProfileId, calendarConnections.provider],
    // ⚠⚠ MANDATORY. The arbiter index is PARTIAL; Postgres only selects a partial index
    // as an ON CONFLICT arbiter when the statement RESTATES its predicate.
    targetWhere: isNull(calendarConnections.deletedAt),
    set: { /* `provider` is INTENTIONALLY absent — it is half the arbiter */ },
  })
  .returning();
```

⚠ Typecheck, lint, and the mocked unit test all stay **green** without `targetWhere` (the unit
test mocks Drizzle and only records the argument object). Only the integration suite catches it.
`isNull()` renders `"deleted_at" is null` with **no bound parameter**, so this is not the
`reference_pg_partial_index_arbiter_param_42p10` hazard — do not "fix" it into raw `sql`.

### 1.4 Repository surface, by class

`calendarRepository` methods are classified in-file. Pick by class, never by convenience:

| Method                                                  | Class           | Notes                                                                                                      |
| ------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `findConnectionByExpertAndProvider`                     | provider-scoped | The sanctioned read. **Inert** until BAL-396                                                               |
| `listConnectionsByExpertProfileId`                      | fan-out         | The free/busy read — union across providers. **Inert**                                                     |
| `findConnectionsByEndUserAccountId`                     | pointer         | **Returns an array** — the index is non-unique on purpose                                                  |
| `updateTargetCalendarIdForProvider`                     | provider-scoped | **Inert**                                                                                                  |
| `softDeleteConnectionForProvider`                       | provider-scoped | Per-provider disconnect. **Inert**                                                                         |
| `findConnectionByExpertProfileId` / `…WithSubCalendars` | legacy-single   | Returns the **oldest** live connection, deterministic by `ORDER BY created_at, id`. Do not use in new code |
| `updateConnectionStatus`                                | fan-out         | ⚠ brands **both** providers — known imprecision, BAL-396 §2                                                |
| `updateTargetCalendarId`                                | fan-out         | ⚠ **wrong** under the amendment; calendar ids are namespaced per provider account                          |
| `softDeleteConnection`                                  | fan-out         | Whole-account disconnect; also the `expert_profiles` teardown path                                         |

⚠ `findConnectionsByEndUserAccountId` returning an array is deliberate: nothing establishes that
one Apiroc End User Account maps to at most one Balo expert, and two experts connecting the same
Google account is routine in dev and seed data. If BAL-396 confirms a vendor one-to-one
guarantee, tighten the **index** first, then narrow the signature.

### 1.5 Tables that do NOT exist yet

SKILL.md's schema block also shows a `calendar_subscriptions` table with `endpointSecret` and
`expiration`. **No such table is in `packages/db` today.** It is BAL-468's. What does exist is
`calendar_sub_calendars` — the per-connection calendar list (`calendar_id`, `name`, `provider`,
`is_primary`, `conflict_check`, `color`), unique on `(connection_id, calendar_id)`, FK
`ON DELETE cascade`. Do not conflate the two: sub-calendars are the conflict-check toggle list;
subscriptions are the webhook registrations.

---

## 2. The connect flow, end to end

### 2.1 Building the authorize URL

```typescript
import { getOAuthUrl } from '@apiroc/unified-calendar-api-node-sdk/oauth';

getOAuthUrl(process.env.APIROC_APP_ID!, 'GOOGLE' | 'MICROSOFT', {
  redirectUrl: process.env.APIROC_REDIRECT_URI!, // must be allowlisted — §2.4
  externalId: expertProfileId, // opaque to Apiroc; NOT an identity lever
  state: createSignedState(expertProfileId, provider), // CSRF + identity — §2.2
  loginHint: providerEmailIfKnown, // prefills the provider login form
  prompt: 'select_account', // free-form string, not an enum [stat]
});
```

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
completes. Never let `state` be derived from a possibly-empty value; assert it non-empty before
the call.

| Param               | Type [stat]                             | Balo rule                                                           |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `appId`             | positional, required                    | `APIROC_APP_ID`                                                     |
| `provider`          | `'GOOGLE' \| 'MICROSOFT'` **uppercase** | Lowercased into the path by the SDK. **APPLE is not accepted here** |
| `redirectUrl`       | optional string                         | Always pass it; must be dashboard-allowlisted                       |
| `externalId`        | optional string                         | Balo's stable expert ref. **Never** trusted for identity — §2.3     |
| `loginHint`         | optional string                         | Optional email prefill                                              |
| `prompt`            | optional **string**                     | Not an enum. `select_account` forces the account chooser **[live]** |
| `state`             | optional string                         | Signed, non-empty, round-trips intact on success **[live]**         |
| `unifiedApiBaseUrl` | optional                                | Defaults `https://api.apiroc.com`. Leave unset                      |

⚠ **Provider casing crosses three vocabularies.** The SDK wants `'GOOGLE'`/`'MICROSOFT'`; Balo's
DB, zod schemas, and `CALENDAR_PROVIDERS` in `services/calendar/sync-capability.ts` all use
lowercase `'google'`/`'microsoft'`; Cronofy used `'office365'` for Microsoft and
`routes/calendar/api.ts::mapProvider` still maps it back. **Store lowercase.** Convert at the SDK
boundary only.

### 2.2 `state` — signing and verification

Balo already owns a signed-state primitive. `apps/api/src/services/cronofy/oauth.ts` (Cronofy
today, the pattern BAL-396 reuses):

```typescript
// Format: base64url(payload).base64url(hmac). Payload = { expertProfileId, provider, ts }.
export function createSignedState(expertProfileId: string, provider: string): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error('INTERNAL_API_SECRET is not configured');
  const payloadB64 = Buffer.from(
    JSON.stringify({ expertProfileId, provider, ts: Date.now() })
  ).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

export function verifySignedState(state: string): SignedStatePayload {
  const [payloadB64, providedHmac] = state.split('.') as [string, string];
  const expectedHmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const a = Buffer.from(providedHmac);
  const b = Buffer.from(expectedHmac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid state signature'); // → redirect ?calendar_error=invalid_state
  }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  if (Date.now() - payload.ts > STATE_TTL_MS) throw new Error('State has expired'); // 10 min
  return payload;
}
```

Rules:

- **`state` is the only identity input the callback may trust.** It is HMAC-SHA256 over the
  base64url payload, compared with `crypto.timingSafeEqual` after a length guard (timingSafeEqual
  throws on a length mismatch — the guard is load-bearing, not decorative).
- TTL is **10 minutes**. Expiry and signature failure are distinct user-facing error codes
  (`state_expired` vs `invalid_state`) so recovery copy can differ.
- The signing secret is `INTERNAL_API_SECRET` — the same secret `requireInternalAuth` uses. It is
  **not** `CALENDAR_ENCRYPTION_KEY` and not an Apiroc credential.
- The shipped error branch parses the payload **without verifying the signature**, purely to put
  `&calendar_provider=…` on the error redirect. That is fine **only** because the value is
  cosmetic. Never authorize, write, or look up on an unverified payload.

### 2.3 `externalId` is not identity

`externalId` is "external identifier from your system" **[stat]**, surfaced on `EndUserAccount`
as `externalId?: string | null`. Setting it to `expertProfileId` is worth doing for vendor-side
debugging. It is **not** an identity or uniqueness lever:

- Apiroc keys an End User Account on **(app, provider, email)** — reconnect returns the **same**
  account id **[live]**, so `externalId` does not partition two Balo experts who connect the same
  provider account.
- The success callback observed in the spike carried `endUserAccountId` and `state` **[live]** —
  **`externalId` was not echoed back.** Do not build a callback that reads it.

### 2.4 `redirectUrl` allowlisting

`redirectUrl` must be registered in the Apiroc dashboard under **Application Details → Authorized
Redirect URIs** **[live]**. `http://localhost:8787/callback` was accepted there — **plain HTTP on
localhost is not rejected for OAuth**, so connect-flow work needs no tunnel. (Webhook `webhookUrl`
is the opposite: HTTPS required **[docs + stat]** — that is BAL-468's problem, not this one.)
Balo's env var is `APIROC_REDIRECT_URI`; `apps/api/src/lib/apiroc/client.ts` deliberately does not
read it (or `APIROC_APP_ID`) — only `APIROC_API_KEY` — because both belong to the connect flow
BAL-396 owns.

---

## 3. The callback handler

### 3.1 Three shapes, and `error` is checked FIRST

| Shape                                                                                | Meaning                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `?endUserAccountId=<id>&state=<state>` **[live]**                                    | Success. The param is literally `endUserAccountId`; `state` is intact. |
| `?provider=GOOGLE&error=missing_required_permissions&error_description=…` **[live]** | Partial consent. **No account was created. Persist nothing.**          |
| neither                                                                              | Must not crash. Redirect to a generic recovery state.                  |

Branch on `error` **first**, before touching `endUserAccountId`. A handler written for the happy
shape either throws on a missing param or — worse — persists `undefined` as a live pointer.

⚠⚠ **The captured error callback carried `provider`, `error`, and `error_description` — and no
`state` [live].** Do not assume `state` survives onto the error branch. Treat expert identity as
**unknown** on that branch: render recovery from the authenticated web session (the expert is
signed in — they just came from `/expert/settings`), never from an unverified query param, and do
not write to `calendar_connections` at all.

`missing_required_permissions` is the **only** snake_case, genuinely enumerable error vocabulary
Apiroc emits. It appears on the OAuth callback query string and nowhere else — the wire `error`
field on API responses is a `string | number | object` union and must never be read as an enum
(see SKILL.md → "Error Handling").

### 3.2 What the shipped handler does (Cronofy — the pattern, not the target)

`apps/api/src/routes/calendar/auth.ts`. Two routes, and the Apiroc arm keeps the same shape:

- `POST /api/calendar/connect`, `preHandler: [requireInternalAuth]`, body
  `{ expertProfileId: uuid, provider: 'google' | 'microsoft' }` → `{ authUrl }`. Called from the
  web Server Action `initiateCalendarConnectAction`, never from the browser directly.
- `GET /auth/cronofy/callback` — **unauthenticated by necessity** (the provider redirects the
  browser here), so `state` carries all the trust.

The callback classifies every failure into a small fixed vocabulary and never leaks internals into
the URL:

```typescript
let errorCode = 'callback_failed';
if (isExpired) errorCode = 'state_expired';
else if (isSignature) errorCode = 'invalid_state';
else if (isO365AdminApproval) errorCode = 'o365_admin_approval';
return reply.redirect(`${webAppUrl}${settingsPath}&calendar_error=${errorCode}${providerParam}`);
```

Success redirects to `…/expert/settings?tab=calendar&calendar_connected=true&calendar_status=…`
and fires `trackServer(CALENDAR_SERVER_EVENTS.OAUTH_COMPLETED, { provider, status, distinct_id })`;
failure fires `OAUTH_FAILED`. ⚠ `OAUTH_COMPLETED`'s `status` prop is typed
`'connected' | 'sync_pending'` in `packages/analytics/src/events/calendar.ts` — an Apiroc status
vocabulary would need that map widened (5-file analytics registration, see
`reference_analytics_registration_is_five_files`).

⚠ **The shipped `callbackQuerySchema` is `{ code, state }` — both required.** That is Cronofy's
authorization-code shape. An Apiroc callback carries **no `code`** and the same schema would
reject every Apiroc callback with `invalid_callback`. BAL-396 needs a new schema shaped as a
discriminated union over the three cases above, not an edit to this one.

### 3.3 Partial consent — the vendor closes the hole, you handle the shape

Google's consent screen has **granular per-scope checkboxes, every one unchecked by default,
including "Select all"**. Completing the flow with nothing ticked produces the error callback
above: Apiroc validates scope grants server-side and **creates no account** **[live]**. So Balo
cannot end up holding a live pointer to a calendar it cannot read — the half-connected-account
risk is mitigated **by the vendor**, not by us. What is left for us is exactly one obligation:
**handle the error shape, and write nothing on it.**

Pin it with a test: _a partial-grant callback never creates a `calendar_connections` row._

---

## 4. What gets persisted, and what must never be

### 4.1 The pointer model

An Apiroc connection persists **`end_user_account_id` + `provider` + `expert_profile_id`**, plus
the derived `target_calendar_id` and display `provider_email`. That is the whole record. Balo
stores **no provider access token, no refresh token, and no token expiry** for Apiroc — the
vendor refreshes provider tokens itself.

⚠ **`endUserAccounts.getCredentials(id)` DOES return raw provider tokens.** `EndUserAccountCredential`
exposes `accessToken`, `refreshToken`, and (Apple) `password` **[stat]**. The "we never hold
tokens" posture is **a choice Balo keeps making, not something the API enforces**. Consequences:

- Prefer `endUserAccounts.get(id)` — it returns `{ id, email, externalId, providerAccountId,
providerType, applicationId, authorizedScopes?, status, createdAt, updatedAt }` **[stat]** and no
  secrets — whenever the status or account metadata is all you need.
- If `getCredentials` is ever called, the credential object must never be logged, never be
  serialised into an error, and never touch a column. The BAL-393 capture scrubber strips
  `accessToken` / `refreshToken` / `password` / `endpointSecret` at any depth including inside
  raw-body **strings** — the same hazard applies to production logging.
- `ApirocError.wireErrorRaw` is defined with `enumerable: false` precisely so Pino's default `err`
  serializer cannot copy a raw wire body into Axiom. Do not re-assign it as a plain property.

### 4.2 `calendar-encryption.ts` — what it covers, and what it does not

`apps/api/src/lib/calendar-encryption.ts`:

```typescript
// AES-256-GCM. Key = sha256(process.env.CALENDAR_ENCRYPTION_KEY) → 32 bytes.
// Output format: `iv:authTag:ciphertext`, all base64. 12-byte random IV per call.
export function encryptCalendarToken(plaintext: string): string;
export function decryptCalendarToken(encryptedValue: string): string; // throws on tamper
```

| Covers today                                                       | Does **not** cover                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Cronofy `access_token` / `refresh_token` in `calendar_connections` | `end_user_account_id` — a pointer, not a secret; store it **plaintext** |
| —                                                                  | Webhook `endpoint_secret` — **there is no such column yet** (BAL-468)   |
| —                                                                  | The signed OAuth `state` — that is HMAC-signed, not encrypted           |

It throws `CALENDAR_ENCRYPTION_KEY is not configured` when the env var is unset, and throws on a
tampered ciphertext **or** a tampered auth tag (pinned in `calendar-encryption.test.ts`). When
BAL-468 adds `endpoint_secret`, encrypt it with this same helper — do not introduce a second
scheme. ⚠ It is **not** a general-purpose secret store: the key is derived by a bare SHA-256 of
the env var (no KDF salt), matching the payout-encryption precedent. Fine for
vendor-issued opaque handles; not a place to put user secrets.

---

## 5. Credential status and reconnect

### 5.1 Two status vocabularies — know which one you are holding

| Vocabulary                                        | Values                                        | Where                                                     |
| ------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Vendor `EndUserAccountCredentialStatus`           | `ACTIVE` \| `EXPIRED` \| `REVOKED` **[stat]** | Returned by `endUserAccounts.get()` / `.getCredentials()` |
| **Balo `calendar_connections.status`** (as built) | `connected` \| `sync_pending` \| `auth_error` | Enforced by CHECK `cal_conn_status_check`                 |

⚠⚠ **SKILL.md's schema block shows a `credential_status` column with the vendor vocabulary. That
column does not exist.** The shipped column is `status`, and the CHECK constraint **rejects**
`'ACTIVE'` with **23514**. An Apiroc writer today must either write one of the three legal values
or omit the field entirely (`.default('connected')` satisfies the CHECK). The
`status → credential_status` rename and the lifecycle that gives `ACTIVE|EXPIRED|REVOKED` meaning
are **BAL-396 §2/§9** — the same slice that introduces the reconnect detection. Do not add the
column ahead of the detection; a status vocabulary nothing writes is worse than none.

⚠ `updateConnectionStatus(expertProfileId, status)` is a **fan-out**: one provider's `auth_error`
brands the other provider's row too. Documented and pinned in the integration suite as "the known
imprecision BAL-396 §2 fixes". If your slice writes status, write it per-provider.

Also **[stat]**: `endUserAccounts.list({ statusFilter })` accepts only `'active' | 'expired'` —
only two of the three vendor values are filterable, which lines up with `REVOKED` looking
unreachable in practice on Google **[live]**.

### 5.2 Detection is error-driven, never status-driven

The full evidence table is in SKILL.md → "Credential expiry & reconnect detection"; do not
duplicate it. The operative facts for a builder:

1. **The status flip is lazy and event-based.** After the user revokes at the provider,
   `endUserAccounts.get()` still says `ACTIVE` and `getCredentials()` still returns **both tokens**
   **[live]**. It flips to `EXPIRED` only once a real data call has already failed. Polling status
   is a _lagging_ record of a failure you have already seen.
2. **A user-initiated revoke surfaces as `EXPIRED`, not `REVOKED`.** Build no distinct UX for the
   two; treat any non-`ACTIVE` value as "reconnect required".
3. **The same condition yields different HTTP statuses depending on timing** — pre-flip
   `401 InvalidRefreshToken`, post-flip `403 "End user account credential expired"`. Map **both**
   onto one internal `RECONNECT_REQUIRED`.
4. **No proactive signal exists.** `enduseraccount.credential.updated` never fired across 5.5
   minutes spanning both the revoke and the status flip, with a live `event` subscription in place
   **[live]**.

⚠⚠ **A 401 does not mean "bad API key".** Through the SDK a revoked expert credential and a bad
platform API key throw the **same class and the same code** (`AuthenticationError` /
`AUTHENTICATION_ERROR`). One means "one expert must reconnect"; the other means "Balo's calendar
integration is down for everyone". Separating them needs `wireMessage`, which is exactly why
`apps/api/src/lib/apiroc/` exists:

```typescript
import { callApiroc, ApirocError } from '../lib/apiroc/index.js';

const calendars = await callApiroc('calendars.list', () =>
  getApirocClient().calendars.list(endUserAccountId)
);
```

`callApiroc` normalises to `ApirocError { kind, operation, status, requestId, retryAfterSeconds,
zodIssues, wireMessage, wireErrorRaw }`. ⚠ `kind` is deliberately **HTTP-status-only**
(`validation | unauthorized | forbidden | not_found | rate_limited | server_error | network |
unknown`) — **`reconnect_required` is not a kind and must not be added to the boundary.** The
boundary classifies by status and carries raw evidence untouched; composing `unauthorized` +
`wireMessage` + the connection's status column into `RECONNECT_REQUIRED` is BAL-396 §2's job, one
layer up. ⚠ `fn` must wrap **exactly one** SDK call — a `Promise.all` fan-out inside `callApiroc`
produces an ambiguous capture and the evidence is dropped (`apiroc_capture_ambiguous`).

### 5.3 The health probe — BAL-396 §9, **not built**

Not shipped. When it is built:

- It must issue a real **data call** per live connection. `calendars.list` is the lightest
  known-good probe. **Not** `endUserAccounts.get()` — polling status cannot work (§5.2).
- Cadence must be justified against per-account limits (Google 600/min, Microsoft 1000/min
  **[docs]**) and expert count.
- On failure: persist the new status per provider and publish the reconnect notification through
  `notificationEvents.publish()` — never a direct Brevo call (CLAUDE.md).
- Worth an explicit test: _a dead credential is detected by the probe, not by a booking attempt._

Without it, the composed failure is: an expert revokes access, Balo shows them connected
indefinitely, nothing changes — **until a client tries to book them.**

### 5.4 Reconnect ORDERING — reconnect FIRST

**reconnect → delete stale subscriptions → re-create.** Never delete first.

Deleting a subscription while the credential is `EXPIRED` returns
`403 "End user account credential expired"` **[live]** — and the credential is expired precisely
_because_ the user revoked, which is the reason you are reconnecting. A delete-then-recreate
procedure is therefore **unexecutable**: at cleanup time the delete is already forbidden.

Reconnect-first works because **`endUserAccountId` is stable across a revoke/reconnect cycle**
**[live]**: the callback returned the same id, the account's `createdAt` was unchanged and
`updatedAt` moved. Apiroc keys the account on (app, provider, email), so reconnect is an UPDATE on
the vendor side, not an INSERT, and the old subscription records stay addressable afterwards.

⚠ Cleanup must be **verified, not best-effort**. A stale subscription keeps delivering duplicate
webhooks for up to 7 days (BAL-468 §4). Whether subscriptions survive a reconnect at all is
**untested** — SKILL.md → "Still unverified".

⚠⚠ **The vendor pointer is stable; the Balo row id is not.** Reconnect after a _disconnect_
INSERTs a **fresh `calendar_connections` row** — the soft-deleted row is invisible to the partial
unique index, so it cannot be the conflict target, and it is left behind as history (pinned:
_"reconnect AFTER disconnect INSERTS a fresh row beside the soft-deleted one"_). Anything keyed on
`connection_id` — `calendar_sub_calendars`, and BAL-468's subscriptions table — must be re-created
against the new row, not looked up by the old one. `endUserAccountId` staying the same does **not**
mean the Balo row did.

---

## 6. The re-consent trap

⚠⚠ **A partial grant cannot be fixed by re-running consent.** Once the expert has granted
anything, Google collapses the consent screen to "already has some access" and **does not re-show
the per-scope checkboxes — even with `prompt=consent`** **[live]**. Sending them back through the
same flow returns them to exactly the state they were in. They loop.

The only recovery is: **revoke at `myaccount.google.com/permissions` first, then reconnect.**
Reconnect copy must say so explicitly, or the expert cannot get out. This is BAL-462; the design
reference is `.claude/design-references/google-calendar-consent-explainer.jsx` (three states:
pre-consent explainer, partial grant, reconnect).

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

### 7.1 As built (Cronofy, whole-account)

`POST /api/calendar/disconnect` → `disconnectCalendar(expertProfileId)` in
`services/cronofy/oauth.ts`, in order:

1. Close the Cronofy push channel — best effort, logged `warn` on failure.
2. Revoke the Cronofy authorization — best effort, logged `warn` on failure.
3. `deleteSubCalendarsByConnectionId(connection.id)` — **hard delete**.
4. `softDeleteConnection(expertProfileId)` — **fan-out**, soft-deletes every live connection.
5. `clearAvailabilityCache(expertProfileId)`.

⚠ Steps 3–5 are **already inconsistent under the new cardinality** and this is a live latent bug
the moment an expert holds two connections: step 3 deletes sub-calendars for **one** connection
(the oldest, via `findConnectionByExpertProfileId`), step 4 soft-deletes **all** of them, and step
5 blanks the whole expert's availability cache. The route body carries **no `provider`** at all.

### 7.2 Per-provider disconnect — the target

The amendment makes "disconnect Google, keep Microsoft" a first-class user action. A correct
per-provider disconnect must:

| Step | Rule                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Take `provider` in the request body and in the analytics event (`CALENDAR_EVENTS.DISCONNECT_INITIATED` already carries `provider`)                                                                                             |
| 2    | Delete that connection's webhook subscriptions **before** soft-deleting the row — verified, not best-effort (BAL-468)                                                                                                          |
| 3    | Hard-delete sub-calendars for **that `connection_id` only**                                                                                                                                                                    |
| 4    | `softDeleteConnectionForProvider(expertProfileId, provider)` — never the fan-out                                                                                                                                               |
| 5    | ⚠ **Recompute** `availability_cache` from the expert's **remaining** live connections. Do **not** `clearAvailabilityCache` — that would mark an expert with a still-connected second provider as having no availability at all |

**Not built, deliberately not decided here:** whether Balo should also call
`endUserAccounts.delete(id)` on disconnect. The Cronofy path revokes at the vendor; the Apiroc
equivalent has never been probed, `endUserAccountId` is shared-by-email across Balo experts in
principle (§1.4), and deleting a vendor account another expert's row still points at would be a
cross-expert break. Treat vendor-side deletion as an open question for BAL-396, not an obvious
mirror of the Cronofy behaviour.

---

## 8. Checklist — adding or changing a connection path

- [ ] **Provider-scoped, not expert-scoped.** Every read and write names `provider`. If you
      reached for `findConnectionByExpertProfileId` / `updateTargetCalendarId` /
      `softDeleteConnection`, justify it or switch to the `…ForProvider` sibling.
- [ ] **Lowercase in the DB, uppercase at the SDK.** `'google'`/`'microsoft'` in every column,
      zod schema, and analytics prop; `'GOOGLE'`/`'MICROSOFT'` only in the `getOAuthUrl` call.
- [ ] **Any new upsert keeps `target: [expertProfileId, provider]` + `targetWhere: isNull(deletedAt)`.**
      Omitting `targetWhere` is 42P10 at plan time with every local gate green.
- [ ] **`state` is non-empty and signed** before `getOAuthUrl` — a falsy `state` is silently
      dropped by the SDK **[stat]**, leaving the flow with no CSRF token.
- [ ] **Callback branches on `error` first**, handles all three shapes, and writes **nothing** on
      the error or empty branch. Do not assume `state` is present on the error branch **[live]**.
- [ ] **No provider tokens persisted, ever**, and no `getCredentials()` result logged, serialised,
      or stored. Prefer `endUserAccounts.get()`.
- [ ] **Status writes use the shipped `connected|sync_pending|auth_error` vocabulary** until
      BAL-396 renames the column — the CHECK rejects `'ACTIVE'` with 23514.
- [ ] **Reconnect detection is error-driven**: map `401 InvalidRefreshToken` **and**
      `403 "credential expired"` onto one internal condition; never poll status as a leading
      indicator.
- [ ] **Reconnect order is reconnect → delete → recreate.** Re-create anything keyed on
      `connection_id`; the Balo row id changed even though `endUserAccountId` did not.
- [ ] **Every SDK call goes through `callApiroc('operation', () => …)`**, one call per wrapper.
      Never consume the SDK's thrown error directly; never branch on the wire `error` field or
      `error.constructor.name`.
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

| For                                                            | Read                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Why the credential status lies; the full revoke evidence table | SKILL.md → "Credential expiry & reconnect detection"                        |
| The SDK's error envelopes, five defects, and retry policy      | SKILL.md → "Error Handling"                                                 |
| What was refuted and why the first skill version was wrong     | SKILL.md → "Hypothesis ledger"                                              |
| Provider semantic divergences (ids, tags, sync tokens)         | SKILL.md → "Provider-parity table", M1–M3                                   |
| Subscription creation, the 7-day expiry, renewal               | SKILL.md → "Subscriptions & lifecycle"; BAL-468                             |
| Raw captured evidence                                          | `spikes/apiroc-probe/FINDINGS.md` on the BAL-393 branch (PR #211, unmerged) |
