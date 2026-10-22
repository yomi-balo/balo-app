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

---

## 1. The connection model, as built

### 1.1 What shipped in `calendar_connections`

`packages/db/src/schema/calendar.ts`; migrations `0067_bal467_apiroc_per_provider_connections.sql`
(the per-provider unique + `end_user_account_id`), `0068_bal396_apiroc_credential_status.sql` (the
`status` → `credential_status` rename, its CHECK, and the health-probe columns), and `0069`
(`end_user_account_id` made `NOT NULL`).

| Column                  | Type                            | As-built truth                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | uuid pk                         | Balo row id. Churns on reconnect-after-disconnect — see §5.4.                                                                                                                                                                                                                                                                                                                               |
| `expert_profile_id`     | uuid not null                   | FK to expert_profiles.id, ON DELETE cascade                                                                                                                                                                                                                                                                                                                                                 |
| `end_user_account_id`   | text not null (since 0069)      | The only vendor identity Balo stores. Non-unique — see the index table below.                                                                                                                                                                                                                                                                                                               |
| `provider`              | text not null                   | 'google' \| 'microsoft' lowercase, no CHECK on it                                                                                                                                                                                                                                                                                                                                           |
| `provider_email`        | text nullable                   | BAL-575 — written on every connect/reconnect from the account `endUserAccounts.get` already fetched (§3.2); never nulled once known — a blank or absent vendor email leaves the stored value alone (§1.3). Rows connected before BAL-575 stay null until they next reconnect — no backfill is planned. Feeds `loginHint` on a future connect (§2.1), and the settings card's `accountLabel` |
| `credential_status`     | text not null, default 'ACTIVE' | Renamed from status by migration 0068. Vocabulary: ACTIVE \| SYNC_PENDING \| EXPIRED \| REVOKED — see §5.1                                                                                                                                                                                                                                                                                  |
| `credential_checked_at` | timestamptz, nullable           | The health probe's and the staleness cron's scan key, not proof the credential works. Stamped on every health-probe attempt, success or classified failure (§5.3), and by upsertApirocConnection's UPDATE arm (a reconnect of a live row); a fresh connect leaves it NULL, which findStaleConnections (§1.4) matches at once                                                                |
| `reconnect_notified_at` | timestamptz, nullable           | "Already notified about the current breakage" marker — see §5.2/§5.3                                                                                                                                                                                                                                                                                                                        |
| `target_calendar_id`    | text nullable                   | Event-write target, per connection (ADR-1021 amendment §1)                                                                                                                                                                                                                                                                                                                                  |
| timestamps / softDelete |                                 | created_at, updated_at, deleted_at                                                                                                                                                                                                                                                                                                                                                          |

Indexes and constraints:

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
the vendor docs establishes that one Apiroc End User Account maps to at most one Balo expert.
Keying an account on (app, provider, email) is **inferred**, not **[live]** — the only captured
fact is that reconnecting the same account returns the same id (§2.3, §5.4); BAL-577 is the spike
that tests the (app, provider, email) claim directly. Two experts' live rows sharing one End User
Account is **possible**, not routine: it needs the vendor to overwrite `externalId` on the second
OAuth, which has never been captured. The index's docblock in `schema/calendar.ts` and
`invariants/calendar-connection-cardinality.test.ts` both assert this table declares **exactly
one** unique index, so a future attempt to tighten this to unique needs vendor evidence first, not
just a hunch. See §7.1's shared-account guard for where this cardinality is handled on disconnect.

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
const [connection] = await db
  .insert(calendarConnections)
  .values({
    expertProfileId,
    provider,
    endUserAccountId,
    providerEmail: providerEmail ?? null,
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
      // BAL-575 — a KNOWN email only. `providerEmail` enters the SET only when it is a
      // non-null string; omitted or `null` leaves the stored value alone (§1.1's "never
      // nulled" rule). The INSERT arm above stores whatever it is given, `null` included.
      ...(typeof providerEmail === 'string' ? { providerEmail } : {}),
      credentialStatus,
      reconnectNotifiedAt: null, // clears the notify-once marker so a SECOND breakage notifies again
      credentialCheckedAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
    // BAL-575 — THE RECONNECT REFUSAL. The DO UPDATE arm fires only when the conflicting row's
    // STORED `end_user_account_id` already equals the incoming one; a different one is refused.
    setWhere: eq(calendarConnections.endUserAccountId, endUserAccountId),
  })
  .returning();

if (connection === undefined) {
  return { outcome: 'refused_account_mismatch' };
}
return { outcome: 'persisted', connection };
```

This is the real, shipped `calendarRepository.upsertApirocConnection` — the **only** writer that
mints a `calendar_connections` row.

⚠ Typecheck, lint, and the mocked unit test all stay **green** without `targetWhere` (the unit
test mocks Drizzle and only records the argument object). Only the integration suite catches it.
`isNull()` renders `"deleted_at" is null` with **no bound parameter**, so this is not the
`reference_pg_partial_index_arbiter_param_42p10` hazard — do not "fix" it into raw `sql`.

⚠⚠ **BAL-575 — RECONNECT WITH A DIFFERENT END USER ACCOUNT IS REFUSED, NOT SILENTLY REPOINTED.**
Without `setWhere`, `onConflictDoUpdate` would repoint a live row at whatever provider account a
reconnect or "Fix permissions" came back signed in to — Balo would stop reading the calendar the
expert thought was still connected (a double-booking risk) and orphan the old End User Account
at the vendor. `setWhere` closes that: the DO UPDATE arm only fires when the conflicting row's
stored pointer already matches the incoming one, so a different account leaves the row
untouched — every column, `updated_at` included.

**The statement decides, not a read before it.** `ON CONFLICT DO UPDATE` locks the conflicting
row and evaluates `setWhere` against its LATEST committed version, so two concurrent callbacks
have no read-then-write window: the second one sees whatever the first just committed. An empty
`.returning()` can therefore only mean refusal — the INSERT arm always returns its row, and an
UPDATE that passes `setWhere` always returns the row it just updated. `setWhere`'s value is bound
as an ordinary `$n` parameter through `eq()`; that is fine here (precedent:
`meetingCalendarEventsRepository.recordIcsDelivery`) — the 42P10 hazard above is specifically
about the ARBITER's `targetWhere`, which Postgres must match against the index predicate at plan
time, not about an ordinary post-arbiter filter like this one.

**The return type carries the outcome.** `upsertApirocConnection` returns the exported
discriminated `UpsertApirocConnectionResult` —
`{ outcome: 'persisted'; connection } | { outcome: 'refused_account_mismatch' }` — never a bare
`CalendarConnection`. A caller may run a diagnostic pre-read alongside the write (`apps/api/src/
services/calendar/apiroc-connection.ts`'s `persistApirocConnection` does, to detect a
same-End-User-Account email change), but that pre-read must never gate or short-circuit the
write; only the statement's own `setWhere` decides refusal.

⚠⚠ **Do not widen `setWhere` on email equality.** The only **[live]** fact is same account ⇒ same
id (§2.3, §5.4); whether the vendor keys an End User Account on email or on the provider's own
account id (`providerAccountId` [stat] on the SDK's `EndUserAccount` type) is unverified. Under the
latter, two accounts that share one address — a Microsoft personal account and a Microsoft work
account, or a recycled Workspace address — get distinct End User Account ids with equal emails,
and an email-equality arm would silently repoint a live row between two different mailboxes: the
exact failure BAL-575 exists to close. Rows connected before `provider_email` was stored (§1.1)
carry `null` and get no help from an email arm either way. The only acceptable future widening is
a compare-and-swap on the STORED pointer, proven gone at the vendor (e.g. `endUserAccounts.get`
answering not_found; the response for a deleted id is uncaptured — BAL-577 must establish it) —
never on a matching email.

### 1.4 Repository surface, by class

`calendarRepository` methods are classified in-file. Pick by class, never by convenience. Every
method below is now checked against its **actual live callers** on this branch, not projected —
"INERT" means what it says: zero callers outside tests, today.

| Method                              | Class            | Live callers today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findConnectionByExpertAndProvider` | provider-scoped  | `routes/calendar/api.ts` (`set-target-calendar` with an explicit `provider`), `services/calendar/apiroc-connection.ts` (`disconnectProvider`). BAL-575 added two more: `routes/calendar/auth.ts` (the connect route's `loginHint` read) and `persistApirocConnection`'s diagnostic pre-read on the OAuth callback                                                                                                                                                                                                                                                                                         |
| `listConnectionsByExpertProfileId`  | fan-out          | `routes/calendar/api.ts` (`GET /connection`'s `connections` array, `disconnect`'s whole-account loop, `findConnectionOwningCalendar`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `findConnectionsByEndUserAccountId` | pointer          | BAL-575 — takes a required `{ excludingConnectionId }` option (a connection id or `null`), so no caller can forget the exclusion. Two callers: the OAuth callback's refusal-cleanup (`discardRefusedEndUserAccount`, §3.2) passes `null` — the just-refused account never got a row of its own to exclude — to check whether ANY live row, for ANY expert, still references it before deleting it at the vendor; `disconnectProvider`'s shared-account guard (§7.1) passes its own row id, since that row is still live when the check runs. Returns an array — the index is non-unique on purpose (§1.1) |
| `upsertApirocConnection`            | provider-scoped  | `services/calendar/apiroc-connection.ts` (`persistApirocConnection`, called from the OAuth callback — §3.2). The only connection writer. BAL-575 — refuses a different EUA on a live row rather than repointing it (§1.3)                                                                                                                                                                                                                                                                                                                                                                                 |
| `setCredentialStatusForProvider`    | provider-scoped  | `services/calendar/apiroc-connection.ts` (`provisionConnection`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `setCredentialStatus`               | connection-keyed | `services/calendar/credential-status.ts` (`flipToReconnectRequired`), `jobs/calendar-health-probe.ts` (recovery path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `markCredentialChecked`             | connection-keyed | `jobs/calendar-health-probe.ts` — the probe's scan-key stamp, on EVERY attempt including a classified failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `markReconnectNotified`             | connection-keyed | `services/calendar/credential-status.ts` — stamped after the notification publish, never before                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `updateTargetCalendarIdForProvider` | provider-scoped  | `routes/calendar/api.ts` (`set-target-calendar`), `services/calendar/apiroc-connection.ts` (`provisionConnection`'s first-connect default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `softDeleteConnection`              | fan-out          | `routes/calendar/api.ts` (`disconnect` with `provider` absent — the whole-account backstop, run after the per-provider loop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `softDeleteConnectionForProvider`   | provider-scoped  | `services/calendar/apiroc-connection.ts` (`disconnectProvider`) — per-provider disconnect is now real, see §7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `findStaleConnections`              | unaffected       | `jobs/availability-cache.ts` — the 15-minute staleness cron. Keys on `credential_checked_at` (§1.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `listConnectionsDueForHealthCheck`  | unaffected       | `jobs/calendar-health-probe.ts` — the probe's candidate scan (§5.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `listBusyReadTargets`               | unaffected       | `services/availability/vendor-busy.ts` — the free/busy read's connection list. Returns non-ACTIVE and unprovisioned connections too, deliberately, so the booking gate can fail closed                                                                                                                                                                                                                                                                                                                                                                                                                    |

⚠ **Status and target-calendar writes are provider-scoped or connection-keyed by construction —
there is no expert-wide setter for either**, so one provider's failure can never brand the other
provider's row. The only expert-wide `calendarRepository` write to `calendar_connections` is
`softDeleteConnection`, the whole-account disconnect backstop (§7.1).

⚠ `findConnectionsByEndUserAccountId` returning an array remains deliberate for the reason in
§1.1: nothing establishes a vendor one-to-one guarantee, and two experts connecting the same
Google account is possible, not routine — it would need the vendor to overwrite `externalId` on a
second OAuth, which has never been captured. Both live callers, and the required exclusion each
one passes, are in the table row above.

### 1.5 Related tables — sub-calendars and subscriptions

Two tables in `packages/db/src/schema/calendar.ts` hang off a connection by `connection_id` (FK
`ON DELETE cascade`). Do not conflate them: sub-calendars are the conflict-check toggle list;
subscriptions are the webhook registrations.

- `calendar_sub_calendars` — the per-connection calendar list (`calendar_id`, `name`, `provider`,
  `profile_name`, `is_primary`, `conflict_check`, `color`), unique on `(connection_id, calendar_id)`.
  `profile_name` stores the connection's `providerEmail` at provisioning time
  (`services/calendar/apiroc-connection.ts`) — display metadata, not an identity field.
- `calendar_subscriptions` — one Apiroc `event` webhook registration per (connection, calendar)
  (`calendar_id`, `webhook_subscription_id`, `endpoint_secret` encrypted per §4.2, `webhook_url`,
  `expiration`, `expiration_synced_at`, `last_delivery_at`), soft-deleted. Unique on
  `webhook_subscription_id` among live rows (`cal_wsub_vendor_id_idx`), and deliberately **not**
  on `(connection_id, calendar_id)`: a create-then-delete renewal holds two live rows for one
  calendar. Disconnect removes them in §7.1 steps 2 and 4.

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
  // BAL-575 — forwarded ONLY when non-empty (see the truthy-guard warning below); resolved
  // by the connect route's best-effort `resolveConnectLoginHint` helper (§2.1).
  ...(loginHint ? { loginHint } : {}),
});
```

⚠ **BAL-575 — Balo now passes `loginHint`; `prompt` is still never sent.**
`POST /api/calendar/connect` (`routes/calendar/auth.ts`) resolves it through
`resolveConnectLoginHint(request, expertProfileId, provider)`, a module-level helper that reads
the (expert, provider)'s stored connection via `findConnectionByExpertAndProvider` and returns its
`provider_email` (§1.1) when known, or `undefined` otherwise. The read is **best-effort and never
throws**: it runs in its own try, separate from the `signConnectState`/`buildApirocAuthorizeUrl`
try (§3.2), so a rejection cannot turn into a 500. On a rejection it `warn`-logs
`apiroc_connect_login_hint_lookup_failed` (`{ expertProfileId, provider, error }` — a message
string, no stack) and returns `undefined`, so the connect proceeds with no hint rather than
failing. `loginHint` is forwarded to `buildApirocAuthorizeUrl` only when truthy. This is a
**prefill, never a guard**: the signed-in party can still choose, or sign in as, a different
account — which is
exactly why the OAuth callback's ownership check (§3.2) and the reconnect refusal (§1.3)
are what actually stop a reconnect from landing on the wrong account, not this parameter.
`prompt` remains unsent — forcing the account chooser is out of scope for BAL-575, which sends
only a prefill. Whether Google's account chooser actually pre-selects the hinted email, and
whether Microsoft's sign-in field is actually prefilled, is **[stat]**-only until confirmed
against the live sandbox (see BAL-575's manual-verification notes) — the SDK guarantees the
parameter is forwarded, not that either provider visibly acts on it.

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

| Param               | Type [stat]                         | Balo rule                                                                                             |
| ------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `appId`             | positional, required                | `APIROC_APP_ID` — read (and validated) in `oauth.ts`, not `client.ts`                                 |
| `provider`          | `'GOOGLE' \| 'MICROSOFT'` uppercase | Lowercased into the path by the SDK. APPLE is not accepted here                                       |
| `redirectUrl`       | optional string                     | Always pass it; must be dashboard-allowlisted                                                         |
| `externalId`        | optional string                     | Balo's stable expert ref. Never trusted for identity — §2.3                                           |
| `loginHint`         | optional string                     | BAL-575 — sent from the stored connection's `provider_email` when known; absent otherwise (see above) |
| `prompt`            | optional string, not an enum        | `select_account` forces the account chooser **[live]** — still not sent by Balo's shipped call        |
| `state`             | optional string                     | Signed, non-empty, round-trips intact on success **[live]**                                           |
| `unifiedApiBaseUrl` | optional                            | Defaults `https://api.apiroc.com`. Leave unset                                                        |

⚠ **Provider casing crosses two vocabularies.** The SDK wants `'GOOGLE'`/`'MICROSOFT'`; Balo's
DB, zod schemas, and `CALENDAR_PROVIDERS` in `services/calendar/sync-capability.ts` all use
lowercase `'google'`/`'microsoft'`. The connect path (`persistApirocConnection`,
`services/calendar/apiroc-connection.ts`) writes the lowercase value straight from the
`z.enum`-validated connect body, carried through the signed `state` (§2.2). `provider` has no
CHECK, so `api.ts::mapProvider` narrows defensively on read: `'microsoft'` stays `'microsoft'`,
and any other value falls back to `'google'`. **Store lowercase.** Convert at the SDK boundary
only (`oauth.ts::toApirocProviderType`).

### 2.2 `state` — signing, verification, and the CSRF-binding cookie

The signed-state primitive lives in `apps/api/src/services/calendar/connect-state.ts`:

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

- Apiroc is **inferred** to key an End User Account on **(app, provider, email)** — never captured
  directly. What IS **[live]** is that reconnect returns the **same** account id (§5.4), so
  `externalId` does not partition two Balo experts who connect the same provider account.
- The success callback observed in the spike carried `endUserAccountId` and `state` **[live]** —
  **`externalId` was not echoed back.** The shipped `callbackQuerySchema` in `routes/calendar/auth.ts`
  confirms this by construction: its only fields are `endUserAccountId`, `state`, `error`,
  `error_description` — there is nowhere to read `externalId` from even if a handler wanted to.

### 2.4 `redirectUrl` allowlisting

`redirectUrl` must be registered in the Apiroc dashboard under **Application Details → Authorized
Redirect URIs** **[live]**. `http://localhost:8787/callback` was accepted there — **plain HTTP on
localhost is not rejected for OAuth**, so connect-flow work needs no tunnel. (Webhook `webhookUrl`
is the opposite: HTTPS required **[docs + stat]**, so `resolveWebhookBaseUrl`
(`services/calendar/webhook-url.ts`) treats a non-`https://` `APIROC_WEBHOOK_BASE_URL` as unset.)
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
  `{ expertProfileId: uuid, provider: 'google' | 'microsoft' }` → `{ authUrl, nonce }`. Before the
  state-signing try, `resolveConnectLoginHint` (§2.1) reads the stored connection for the
  `loginHint` prefill — best-effort: a failed read `warn`-logs
  `apiroc_connect_login_hint_lookup_failed` and the connect proceeds without a hint, never a 500.
  Signs `state` via `signConnectState`, then **immediately re-verifies its own freshly-signed
  state** purely to extract `nonce` — cheap, never expired, never tampered, so this is an
  extraction, not a trust boundary. Called from the web Server Action
  `initiateCalendarConnectAction` (§2.2), never from the browser directly. `apps/web` binds
  `nonce` to the per-provider CSRF cookie **before** handing `authUrl` back to the browser.
- `GET /auth/apiroc/callback` — **unauthenticated by necessity** (the provider redirects the
  browser here), so `state` plus the CSRF cookie carry all the trust.

`ctx.webAppUrl` reads **`APP_URL`**, not `WEB_APP_URL` — that variable is undocumented and unset
in production; `APP_URL` is the one every other user-facing link already uses. The callback
branches on the three shapes from §3.1, in order:

**Shape 1 — `error` present** (`handleCallbackErrorShape`): classifies via `classifyCallbackError`
(matches `error`/`error_description`, case-insensitively, against `PARTIAL_GRANT_MARKERS`
(`missing_required_permissions`) and `O365_ADMIN_MARKERS` (`access_denied`, `consent_required`,
`admin_approval` — Microsoft/AAD OAuth vocabulary, **plausible but still unverified against a
live Apiroc Microsoft callback**), else `callback_failed` and a `warn` log so the real
vocabulary is learned from production rather than guessed at again. Extracts
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
4. **The vendor-account ownership binding** (`resolveOwnedEndUserAccount`, BAL-397 + BAL-575):
   one `endUserAccounts.get(endUserAccountId)` call, wrapped in `callApiroc`.
   `account.externalId` must equal the HMAC-trusted `expertProfileId` — a mismatch, a missing
   `externalId`, or a failed lookup (404/401/403/5xx/timeout) all fail CLOSED through the same
   opaque `state_csrf_mismatch` redirect the CSRF check uses (never a distinct code, so the
   route never becomes an existence oracle for vendor account ids — see the `rejectShape2`
   docblock). On a match, the account's `email` is read defensively — `typeof account.email ===
'string' ? account.email.trim() : ''`, never a bare `.trim()` — because the SDK types `email`
   as `string` but that is a type claim, not a wire guarantee; blank, `null`, and absent all
   become `null`. The result is carried forward as `providerEmail` — this is the **single**
   `endUserAccounts.get` call on the happy path (§4.1); nothing downstream re-fetches it.
5. Match → `persistAndRedirectConnected`: `persistApirocConnection({ …, providerEmail })` → a
   diagnostic pre-read (`findConnectionByExpertAndProvider`, never gates the write — §1.3) →
   `upsertApirocConnection` (the single statement decides, §1.3).
   - **Refused** (`outcome: 'refused_account_mismatch'` — BAL-575): a live row already
     points this (expert, provider) at a DIFFERENT End User Account. `rejectAccountMismatch`
     `warn`-logs `apiroc_callback_reconnect_account_mismatch` (ids and provider only, never an
     email), fires `trackServer(OAUTH_FAILED, { error_code: 'account_mismatch', ... })` exactly
     once, runs the refused-account vendor cleanup (`discardRefusedEndUserAccount` —
     best-effort and NEVER throws: it shares its live-reference rule with `disconnectProvider`
     through the one `findConnectionsByEndUserAccountId` read (§7.1), called with
     `{ excludingConnectionId: null }` — nothing is excluded, because the just-refused account
     never got a `calendar_connections` row of its own to exclude. A non-empty result retains the
     account rather than deleting it; an empty one deletes it, logging a warn on a delete failure
     without changing the outcome), then redirects
     `calendar_error=account_mismatch&calendar_provider=<provider>`. **Nothing downstream of the
     refusal runs**: no `provisionConnection`, no availability rebuild, no subscription
     reconcile, no searchability reconcile, no `OAUTH_COMPLETED`.
   - **Persisted, same-account email drift** (`providerEmailChanged: true` — BAL-575): the
     End User Account is unchanged, but the pre-read's stored email and the freshly-fetched
     email are both known and differ case-insensitively. `apiroc_callback_provider_email_changed`
     is `warn`-logged (booleans and ids only, never either email) and the connect proceeds
     unchanged — a DB refusal cannot undo an account swap the vendor already made behind that id;
     this is a signal for the BAL-577 spike, not an error to act on here.
   - **Persisted, happy path**: `provisionConnection` (list calendars, choose the target, set
     `credentialStatus`, §1.4/§5.1) → `enqueueAvailabilityCacheRebuild` → only when
     `status === 'ACTIVE'` (a `SYNC_PENDING` connection has no sub-calendars yet, so there is
     nothing to subscribe), `enqueueSubscriptionReconcile(connection.id, { force: true }, …)`
     (BAL-468 §8.4/§8.6) then the searchability re-list (`reconcileAfterConnect`, its own
     try/catch so a reconcile failure never turns a successful connect into
     `callback_failed`) → `trackServer(OAUTH_COMPLETED, { provider, status: analyticsStatus,
distinct_id })` where `analyticsStatus` is the plain ternary
     `status === 'ACTIVE' ? 'connected' : 'sync_pending'` (exhaustive: `provisionConnection`
     only ever returns those two; this legacy vocabulary is for the PostHog funnel only) →
     redirect `…&calendar_connected=true&calendar_status=<status>&calendar_provider=<provider>`
     — the REDIRECT carries the real `ACTIVE`/`SYNC_PENDING` value, not `analyticsStatus`; only
     the analytics call uses the legacy words. A failure **after** the connection row already
     exists still redirects (never a 500) with `calendar_error=callback_failed&calendar_provider=
<provider>` — retrying from this same response would fail the now-consumed CSRF check
     rather than proceeding cleanly, so failing loud here (with a `log.error`) matters.

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
**no provider access token, no refresh token, and no token expiry** — `calendar_connections` has
no column for any of them, and the vendor refreshes provider tokens itself.

⚠ **`endUserAccounts.getCredentials(id)` DOES return raw provider tokens.** `EndUserAccountCredential`
exposes `accessToken`, `refreshToken`, and (Apple) `password` **[stat]**. The "we never hold
tokens" posture is **a choice Balo keeps making, not something the API enforces** — though the
schema enforces it on Balo's side (there is no column to put one in).
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

### 4.2 The one calendar secret Balo encrypts — `endpoint_secret`

Balo encrypts exactly one calendar secret at rest: `calendar_subscriptions.endpoint_secret`, the
per-subscription Svix verification secret. Its cipher is `apps/api/src/lib/calendar-encryption.ts`
(`encryptCalendarSecret` / `decryptCalendarSecret`): AES-256-GCM, `iv:authTag:ciphertext` (all
base64), under its own `CALENDAR_ENCRYPTION_KEY` — never `PAYOUT_ENCRYPTION_KEY`
(`lib/encryption.ts`), which guards a different trust boundary.
`services/calendar/subscription-reconcile.ts` encrypts on create and `routes/calendar/webhook.ts`
decrypts to verify a delivery; `webhooks-and-events.md` A1 has the usage rules.

Nothing else on the connection path is encrypted: `end_user_account_id` is a pointer, not a
secret (store it plaintext, per §4.1); the signed OAuth `state` is HMAC-signed, not encrypted
(§2.2); and there is no provider token to protect (§4.1).

---

## 5. Credential status and reconnect

### 5.1 The credential-status vocabulary

| Vocabulary                                                   | Values                                               | Where                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Vendor `EndUserAccountCredentialStatus`                      | `ACTIVE` \| `EXPIRED` \| `REVOKED` **[stat]**        | Returned by `endUserAccounts.get()` / `.getCredentials()`                |
| **Balo `calendar_connections.credential_status`** (as built) | `ACTIVE` \| `SYNC_PENDING` \| `EXPIRED` \| `REVOKED` | Enforced by CHECK `cal_conn_credential_status_check`, default `'ACTIVE'` |

`'ACTIVE'` is the column's **default**, and the CHECK rejects any value outside these four. Three
of the four values mirror the vendor enum exactly; `SYNC_PENDING` is **Balo-side only**, with no
vendor counterpart: it means "the credential is live at Apiroc but Balo has not finished first
provisioning (no sub-calendar rows / no target calendar yet)." A `SYNC_PENDING` connection is
UNREADABLE for free/busy — `listBusyReadTargets` (§1.4) still returns it (deliberately, so the
caller can tell "cannot check" from "nothing to check"), and the booking gate must fail
**closed** on it, never treat it as "no calendar."

`.$type<CalendarCredentialStatus>()` on the column is **load-bearing, not documentation**: it
makes a literal outside the four values — `eq(calendarConnections.credentialStatus, 'active')`,
say — a compile error rather than a query that compiles, runs, and silently matches zero rows
forever. `findStaleConnections`' `ACTIVE` filter (§1.4) is where that would bite: the 15-minute
staleness cron would find nothing and report nothing wrong.

⚠ **There is no expert-wide status setter** (§1.4) — status writes are provider-scoped
(`upsertApirocConnection`, `setCredentialStatusForProvider`) or connection-keyed
(`setCredentialStatus`), so one provider's `EXPIRED` never brands the other provider's row.

⚠ The four values reach `apps/web` verbatim: `GET /api/calendar/connection` returns
`credentialStatus` as stored, and the callback's success redirect carries
`calendar_status=ACTIVE|SYNC_PENDING` (§3.2). `EXPIRED` and `REVOKED` share one "Reconnect needed"
UX but stay distinct in `GET /api/calendar/connection`'s `credentialStatus` — do not collapse
them there.

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

**reconnect → re-create → delete stale subscriptions.** Never delete first.
`services/calendar/subscription-reconcile.ts` makes no vendor call for a connection that is not
`ACTIVE` (it skips with `connection_not_active`), so it never attempts a delete while the
credential is broken. A reconnect that lands `ACTIVE` through the OAuth callback (§3.2), or an
out-of-band recovery the health probe detects (§5.3), enqueues
`enqueueSubscriptionReconcile(connection.id, { force: true }, …)`, which re-creates the
connection's subscriptions and deletes each one it supersedes only after the replacement is
created and stored (create-then-delete, `webhooks-and-events.md` A5). A reconnect whose
provisioning lands `SYNC_PENDING` enqueues no reconcile; when the probe later re-provisions it to
`ACTIVE` it reconciles with `force: false`, which re-creates only subscriptions the vendor no
longer lists or that are inside the renewal lead time. The vendor evidence behind
the rule:

Deleting a subscription while the credential is `EXPIRED` returns
`403 "End user account credential expired"` **[live]** — and the credential is expired precisely
_because_ the user revoked, which is the reason you are reconnecting. A delete-then-recreate
procedure is therefore **unexecutable**: at cleanup time the delete is already forbidden.

Reconnect-first works because **`endUserAccountId` is stable across a revoke/reconnect cycle**
**[live]**: the callback returned the same id, the account's `createdAt` was unchanged and
`updatedAt` moved. Apiroc is **inferred** to key the account on (app, provider, email) — never
captured directly, only the same-account ⇒ same-id result above — so reconnect is an UPDATE on the
vendor side, not an INSERT, and old subscription records would stay addressable afterwards.

⚠⚠ **The vendor pointer is stable; the Balo row id is not — and this is now proven, shipped
behaviour, not a hazard to design around.** `upsertApirocConnection`'s ON CONFLICT arbiter
(`target: [expertProfileId, provider]`, `targetWhere: isNull(deletedAt)`) means a
reconnect-after-_disconnect_ cannot match the soft-deleted row (it is invisible to the partial
index) and therefore **INSERTs a fresh `calendar_connections` row**, leaving the old one behind as
history. Anything keyed on `connection_id` — `calendar_sub_calendars` and
`calendar_subscriptions` — must be re-created against the **new** row, never looked up by the old
one. `endUserAccountId` staying the same does **not** mean the Balo row did. (A
reconnect that is **not** preceded by a disconnect — the connection is still live, just
credential-broken — goes through the same upsert's UPDATE arm instead, and the row id does _not_
churn; see `provisionConnection`'s "only default the target calendar when unset" rule in §3.2,
which exists specifically because that arm is a re-provision of an existing row, not a fresh one.)

⚠ The reconciler's cleanup is **verified, not best-effort**: after running its plan it re-reads
`calendarSubscriptions.list` and logs `apiroc_subscription_delete_unverified` (error) for every
intended delete the vendor still lists, because a stale subscription keeps delivering duplicate
webhooks for up to 7 days. Whether subscriptions survive a reconnect at all is **still untested**
(SKILL.md → "Still unverified"); on the two forced paths the re-create makes the answer not
matter, but a reconnect healed through re-provisioning (`force: false`) keeps any subscription the
vendor still lists.

⚠⚠ **BAL-575 — the UPDATE arm above only fires when the incoming End User Account matches the
STORED one.** A reconnect (or Fix permissions) that comes back signed in to a different account
never reaches this section's UPDATE-vs-INSERT split at all: `upsertApirocConnection`'s `setWhere`
refuses it before either arm's effects happen, and the row is left exactly as it was (§1.3). There
is no partial reconnect-ordering concern to reason about for that case, because nothing about the
connection changed. Switching accounts is not a reconnect — it needs **Disconnect (§7), then Add
calendar**, which goes through the INSERT arm as a genuinely fresh connection, the same as any
reconnect-after-disconnect above.

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

### 7.1 As built — per-provider, with vendor-side deletion

`POST /api/calendar/disconnect` (`routes/calendar/api.ts`), body
`{ expertProfileId, provider? }`:

- **`provider` present** → `disconnectProvider(expertProfileId, provider)` only. That provider's
  connection is removed; the expert's other live connection (if any) is untouched.
- **`provider` absent** → the whole-account contract: loop `disconnectProvider` over every live
  connection (`listConnectionsByExpertProfileId`), **then** call `softDeleteConnection` (the
  fan-out) as a defensive backstop for any live row the loop did not enumerate. No shipped caller
  takes this arm: the web action (`_actions/disconnect-calendar.ts`) requires `provider`, so one
  provider's disconnect cannot escalate into an account-wide one.

Either way, the route then **enqueues** an availability-cache **rebuild** (never a clear) —
`enqueueAvailabilityCacheRebuild` — because with two providers connected, disconnecting one must
recompute from the remaining one, not blank the cache outright. It fires
`trackServer(DISCONNECTED, { provider?, distinct_id })` (provider absent on the whole-account
path).

`disconnectProvider` (`services/calendar/apiroc-connection.ts`), in order:

1. Look up the (expert, provider) connection via `findConnectionByExpertAndProvider`. No row → no-op.
2. **Per-subscription vendor deletes, best-effort and unguarded** —
   `deleteVendorSubscriptionsBestEffort` loops `calendarSubscriptionsRepository.listLiveByConnectionId(connection.id)`
   and calls `calendarSubscriptions.delete` for each row. No shared-account check here: each
   subscription's `webhookSubscriptionId` belongs to exactly one Balo row (FK `connection_id`;
   `cal_wsub_vendor_id_idx` makes `webhook_subscription_id` unique among live rows —
   `schema/calendar.ts`), so nothing else can be depending on it.
3. **The shared-account check, then best-effort vendor account deletion** —
   `deleteEndUserAccountBestEffort` (BAL-575). One try wraps the whole step, so a failed read and
   a failed delete land in the same `apiroc_disconnect_vendor_delete_failed` warn and either way
   nothing more is deleted:
   - `findConnectionsByEndUserAccountId(connection.endUserAccountId, { excludingConnectionId:
connection.id })` — **excludes this row's own id**, because it is still live when the check
     runs (this row soft-deletes only in step 6, below). A non-empty result means another live
     row — another expert's, in the inferred shared-callback case (§1.1) — still references this
     End User Account: `log.info` `apiroc_disconnect_shared_account_retained`
     (`{ connectionId, expertProfileId, referencingConnections }`) and return without deleting.
   - Empty → `callApiroc('endUserAccounts.delete', () =>
client.endUserAccounts.delete(connection.endUserAccountId))`, the existing best-effort vendor
     call. If it fails, Balo's side is still removed; leaving a row the expert asked to disconnect
     is the worse failure.
4. `calendarSubscriptionsRepository.softDeleteByConnectionId(connection.id)` — Balo's own
   subscription rows, soft-deleted regardless of whether their vendor-side deletes in step 2
   succeeded.
5. `deleteSubCalendarsByConnectionId(connection.id)` — **hard delete**, scoped to **this**
   connection only.
6. `softDeleteConnectionForProvider(expertProfileId, provider)` — soft-deletes **only** this
   provider's row.

No null guard on `endUserAccountId`: migration `0069` made it `NOT NULL`, so the shared-account
check always has a pointer to look up. The vendor account delete runs only when that check finds
no other live row and the read succeeded.

**The shared-account guard, as built (BAL-575).** Step 3 closes the gap this section used to
flag: `disconnectProvider`'s vendor-side `endUserAccounts.delete()` no longer runs
unconditionally — it first asks, excluding its own row, whether any other live
`calendar_connections` row still references this End User Account, and retains the vendor account
rather than deleting it when one does. **Self-exclusion is mandatory**: the disconnecting row is
itself still live at the moment the check runs, so a query that did not exclude it would always
find at least that one row and never delete anything. The check and the vendor delete are **not
atomic** — another expert's connect can land on this same End User Account between the read and
the delete, and no DB lock can span a vendor HTTP call — so the guard narrows the window rather
than closing it; this is accepted, not a residual bug. Whether the callback can actually produce
two experts sharing one End User Account at all is itself **inferred**, not **[live]** (§1.1): it
needs the vendor to overwrite `externalId` on a second OAuth, which has never been captured. If it
does happen and a retained account keeps the _disconnecting_ expert's `externalId`, that is
harmless: under the same overwrite premise, the other expert's own Reconnect rewrites
`externalId` to their id before the ownership check (`resolveOwnedEndUserAccount`, §3.2) reads it.

**The residual case this guard does not cover.** An End User Account deleted **outside** Balo —
at the vendor dashboard, by vendor-side cleanup, or a dev-only row orphaned before this guard
shipped — still leaves a live `calendar_connections` row whose `end_user_account_id` no longer
exists at the vendor. A same-account Reconnect or Fix permissions against that row is **refused**
(`upsertApirocConnection`'s `setWhere`, §1.3), because the freshly-returned account id can never
equal a stored id that is gone. Recovery is **Disconnect, then Add calendar** — Disconnect
soft-deletes the dead row (its vendor call no-ops or fails harmlessly, since there is nothing left
to delete), and Add calendar goes through the INSERT arm as a genuinely fresh connection. The
generic "different account" toast copy is inaccurate for this specific case; a dead-pointer
self-repair that would detect and recover it automatically is deferred pending BAL-577's evidence
(§1.3).

---

## 8. Checklist — adding or changing a connection path

- [ ] **Provider-scoped, not expert-scoped.** Every read and write names `provider`. If you
      reached for `softDeleteConnection` (the fan-out), justify it or switch to the
      `…ForProvider` sibling.
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
      or stored. Prefer `endUserAccounts.get()`. The only calendar secret at rest is
      `calendar_subscriptions.endpoint_secret`, under `lib/calendar-encryption.ts`'s own key (§4.2).
- [ ] **Status writes use the `ACTIVE|SYNC_PENDING|EXPIRED|REVOKED` vocabulary** —
      `cal_conn_credential_status_check` **rejects** anything else, and the column's `.$type`
      makes an out-of-vocabulary literal a compile error (§5.1).
- [ ] **Reconnect detection is error-driven**: run failures through
      `classifyCredentialFailure` (`lib/apiroc/reconnect.ts`) and `applyCredentialFailure`
      (`services/calendar/credential-status.ts`) — the one place a credential is marked broken.
      Never poll status as a leading indicator, and never hand-roll a second discriminator between
      an expert-side revoke and a platform-key fault.
- [ ] **Reconnect order is reconnect → re-create → delete stale subscriptions** — no reconnect
      path deletes a subscription before the connection is `ACTIVE` again. Re-create anything
      keyed on `connection_id`; the Balo row id changed even though `endUserAccountId` did not,
      on a reconnect that follows a disconnect (§5.4).
- [ ] **Every SDK call goes through `callApiroc('operation', () => …)`**, one call per wrapper.
      Never consume the SDK's thrown error directly; never branch on the wire `error` field or
      `error.constructor.name`.
- [ ] **A per-provider disconnect that calls vendor deletion reuses
      `findConnectionsByEndUserAccountId` with the row's own id excluded, as `disconnectProvider`
      does (§7.1)** — never a bare unconditional vendor delete.
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
| Subscription creation, the 7-day expiry, renewal               | SKILL.md → "Subscriptions & lifecycle"                                      |
| Raw captured evidence                                          | `spikes/apiroc-probe/FINDINGS.md` on the BAL-393 branch (PR #211, unmerged) |
