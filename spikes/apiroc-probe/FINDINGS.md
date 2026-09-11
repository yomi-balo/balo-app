# BAL-393 — Apiroc (OneCal) runtime behaviour: findings

> **Status: Phases 0, 1 and 2 complete. All four unknowns answered.**
> Four of the six standing hypotheses are **refuted**; one is confirmed. One question is
> deliberately left open and cannot be closed by this spike: whether Apiroc auto-renews
> subscriptions before their 7-day expiry (Unknown 3). Proposed follow-up issues are in
> **[Handoff](#handoff--work-this-spike-creates)** — T1–T14, each scoped to become one
> Linear ticket.
> Rule for this document: an answer is only filled in when evidence backs it. Each row is
> tagged **[live]** (real API response, saved under `captures/`) or **[static]** (read out
> of the published SDK bundle — ground truth for SDK behaviour, but not API behaviour).
> Assumptions stay marked as hypotheses.

- Sandbox app: _(App ID recorded in `.env`, not here)_
- Providers in scope: **Google + Microsoft**. Apple/iCloud out of scope (parked).
- Captured on: 2026-08-14

## ⚠️ Finding 0 — the SDK named in the ticket is deprecated and has been replaced

The ticket and `.claude/skills/onecal/SKILL.md` both target
`@onecal/unified-calendar-api-node-sdk` (ticket says v1.2.0, skill says v1.2.2). **[live]**

- `@onecal/unified-calendar-api-node-sdk` is **deprecated on npm** — _"Package no longer
  supported."_ Last version `1.3.1`.
- It has been republished as **`@apiroc/unified-calendar-api-node-sdk`**, currently
  **`2.0.1`**, first published **2026-08-05** (same maintainer, `kleo@onecal.io`; same
  GitHub repo `OneCal/unified-calendar-api-node-sdk`). Not deprecated.
- This spike therefore probes **v2.0.1**, not the v1.x the ticket pinned.

**The v2 break is narrower than the major bump suggests.** The client class
(`UnifiedCalendarApi`), all six resource classes, every method signature, the error
classes, and `EndUserAccountCredentialStatus` are unchanged from the surface the skill
documents. Two real deltas found so far:

| Delta                                | Old (skill / ticket)                     | v2.0.1 **[static]**                                         |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| Default base URL                     | `https://api.onecalunified.com`          | **`https://api.apiroc.com`** (both hosts answer)            |
| `calendarSubscriptions.create` input | `{ calendarId, webhookUrl, rateLimit? }` | adds **required** `subscriptionType: 'calendar' \| 'event'` |

→ Both are corrections owed to the skill (BAL-395) and affect BAL-396's wiring.

---

## Standing hypotheses from `.claude/skills/onecal/SKILL.md`

The skill already asserts answers to some of these unknowns. It was written from docs and
SDK types, **not** from observed behaviour — which is exactly what this spike exists to
check. Each claim below is a hypothesis to **confirm or refute with a capture**, and a
refutation means the skill gets corrected (BAL-395).

| #   | Skill claim                                                                                               | Where                     | Verdict                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| H1  | Subscriptions **don't expire**; OneCal auto-renews the provider channels, so **no renewal job is needed** | Constraint 2              | ❌ **REFUTED** — hard **7-day** expiry, hidden from the create response. Auto-renew unconfirmed. See Unknown 3.            |
| H2  | Webhook body is a thin `{ eventType, timestamp }` carrying **no account/calendar identity**               | Webhooks §, Constraint 2  | ✅ **CONFIRMED [live]** — exactly that, no identity fields. URL-encoded identity is required. See Unknown 4.               |
| H3  | The string `code` is **opaque and unenumerated** — use for telemetry, never control flow                  | Error Handling §          | ❌ **REFUTED** — enumerable, hardcoded, and `undefined` on `APIRequestError`. See Unknown 1.                               |
| H4  | `ValidationError` is exported but **never thrown**                                                        | Error Handling §          | ✅ **confirmed [live + static]** — server-side 400s arrive as `APIRequestError`                                            |
| H5  | Reconnect must be driven off `credentialStatus`, **not** off error codes                                  | Delta 2, Error Handling § | ❌ **REFUTED** — status stays `ACTIVE` after revocation and only flips once a data call has already failed. See Unknown 2. |
| H6  | Sandbox rate limit is **20 req/s** per API key, with `Retry-After` on 429                                 | Error Handling §          | ◐ `Retry-After` is read into `RateLimitError.retryAfter` **[static]**; live magnitude pending                              |

⚠️ **H1 landed badly.** Subscriptions carry a hard **7-day** expiry, and the create response
reports `expiration: null` — only `calendarSubscriptions.list` reveals it. Whether Apiroc
auto-renews before then is **still unconfirmed** and cannot be settled without watching a
subscription for 7 days. If renewal is caller-managed, BAL-396 needs a scheduled job that is
currently unplanned, and every expert's sync dies silently a week after connecting.

---

## Unknown 1 — Error vocabulary

**Question:** the real `code` + HTTP `status` per failure, so the adapter can branch
(reconnect vs retry vs backoff vs full-resync).

### Answer: there is no machine-readable error code on the wire, and there are TWO different error envelopes. Branch on HTTP status.

**[live] — full Phase 0 run, `pnpm phase0`, base `https://api.apiroc.com`, all captures in
`captures/phase0/`.** Baseline with the real key returned `200 {"data":[],"nextPageToken":null}`,
so everything below is interpretable.

| Probe                     | HTTP  | Envelope | Wire body (verbatim)                                                                   | SDK class             | SDK `.code`            | SDK `.message`                            |
| ------------------------- | ----- | -------- | -------------------------------------------------------------------------------------- | --------------------- | ---------------------- | ----------------------------------------- |
| baseline (valid key)      | `200` | —        | `{"data":[],"nextPageToken":null}`                                                     | did not throw         | —                      | —                                         |
| missing key               | `401` | **A**    | `{"error":"Error","message":"Missing X-API-Key header.","requestId":"…"}`              | `AuthenticationError` | `AUTHENTICATION_ERROR` | `Missing X-API-Key header.`               |
| bad key                   | `401` | **A**    | `{"error":"Error","message":"Invalid X-API-Key.","requestId":"…"}`                     | `AuthenticationError` | `AUTHENTICATION_ERROR` | `Invalid X-API-Key.`                      |
| unknown account           | `404` | **A**    | `{"error":"Error","message":"End user account not found","requestId":"…"}`             | `NotFoundError`       | `NOT_FOUND`            | `End user account not found`              |
| unknown calendar          | `404` | **A′**   | `{"error":404,"message":"Not Found","requestId":"…"}` ← `error` is a **number** here   | `NotFoundError`       | `NOT_FOUND`            | `Not Found`                               |
| malformed body (freeBusy) | `400` | **B**    | `{"success":false,"error":{"name":"ZodError","message":"<JSON-encoded issue array>"}}` | `APIRequestError`     | **`undefined`**        | **`Request failed with status code 400`** |
| missing required field    | `400` | **B**    | `{"success":false,"error":{"name":"ZodError","message":"<JSON-encoded issue array>"}}` | `APIRequestError`     | **`undefined`**        | **`Request failed with status code 400`** |

**Two incompatible envelopes:**

- **Envelope A** (401 / 404, presumably 5xx) — `{ error, message, requestId }`. The `error`
  field is **not even consistently typed**: it is the literal string `"Error"` on
  auth/account failures, but the **number `404`** on an unknown _calendar_ (`A′`). It
  carries no information in either form — the only discriminating signal is the
  human-readable `message`, and even that degrades: an unknown account says
  `"End user account not found"`, while an unknown calendar says only `"Not Found"`.
  A TypeScript type for this field would have to be `string | number`, which is by itself
  enough reason never to branch on it.
- **Envelope B** (400 validation) — `{ success: false, error: { name: "ZodError", message } }`.
  **No top-level `message`. No `requestId` in the body.** The nested `error.message` is a
  **double-encoded JSON string** of a Zod issue array; parsing it yields the real detail:

  ```json
  [
    {
      "expected": "string",
      "code": "invalid_type",
      "path": ["title"],
      "message": "Invalid input: expected string, received undefined"
    },
    { "expected": "object", "code": "invalid_type", "path": ["start"], "…": "…" }
  ]
  ```

**`x-request-id` is on the response HEADER of every response** (200s included) — captured on
all seven probes. On Envelope A it is duplicated into the body; on Envelope B the header is
the **only** copy.

✔ **`unknown-calendar` resolved.** An earlier pass used a bogus _account_ id as well, and the
API validates the account first, so it merely repeated "End user account not found". Re-run
against the real throwaway account, a genuine calendar-level 404 returns the `A′` shape
above. **Resolution order confirmed: account before calendar.**

### How the SDK normalises it **[static — `dist/index.js` response interceptor]**

| HTTP                    | Thrown class              | `.code`                | Source of `.code`                                                      |
| ----------------------- | ------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| 401                     | `AuthenticationError`     | `AUTHENTICATION_ERROR` | hardcoded constant                                                     |
| 403                     | `AuthorizationError`      | `AUTHORIZATION_ERROR`  | hardcoded constant                                                     |
| 404                     | `NotFoundError`           | `NOT_FOUND`            | hardcoded constant                                                     |
| 429                     | `RateLimitError`          | `RATE_LIMIT_EXCEEDED`  | hardcoded constant; `.retryAfter` parsed from the `Retry-After` header |
| 400 / 409 / 5xx / other | `APIRequestError`         | `data?.code`           | **always `undefined` — see below**                                     |
| no HTTP response        | `UnifiedCalendarApiError` | —                      | network/timeout                                                        |

All confirmed **[live]** by the run above.

### Four defects that change how the adapter must be written

1. **On a 400, the SDK discards the entire error payload. [live]** This is the worst of
   them. The interceptor computes `message = data?.message || error.message`, but Envelope B
   has no top-level `message` — so it falls through to axios's generic
   **`"Request failed with status code 400"`**. `code` and `details` are `undefined` for the
   same reason. **Every validation failure is indistinguishable from every other validation
   failure through the SDK**: which field was wrong, and why, is thrown away before it
   reaches the caller. Debugging a malformed request via the SDK alone is impossible.

2. **`.code` is `undefined` on exactly the errors you'd want it for.** The interceptor reads
   `const code = data?.code`; the API never sends `data.code` (it sends `data.error`). For
   401/403/404/429 `code` is a hardcoded constant that merely restates the HTTP status; for
   400/409/5xx it is `undefined`. `details` is always `undefined` (no such wire field).
   → **Below the HTTP status there is no machine-readable signal at all.**

3. **`requestId` is silently dropped. [live]** Present as the `x-request-id` header on every
   response and in the body on Envelope A; the interceptor copies neither onto the thrown
   error. Vendor support escalation would have nothing to quote.

4. **The subclasses all extend `APIRequestError`**, which extends `UnifiedCalendarApiError`.
   An `instanceof APIRequestError` branch therefore **also catches** 401/403/404/429 — order
   checks most-specific-first. Runtime class names are bundler-mangled
   (`_AuthenticationError`), so **never branch on `error.constructor.name`**;
   `Object.setPrototypeOf` is called in every constructor, so `instanceof` is reliable.

### Recommendation for BAL-396

**Do not consume the SDK's thrown errors directly.** Install an axios response interceptor
(the SDK exposes the axios instance via `BaseClient`) or wrap every call, and before the
SDK's own interceptor mangles the failure, capture:

- the `x-request-id` header → attach to the error and log it;
- the raw response body → on Envelope B, `JSON.parse(body.error.message)` to recover the
  Zod issue array (field paths + reasons) for logs;
- then branch on **HTTP status only**.

Treat 400 as a permanent programming error (never retry), 401/403 as credential problems,
404 as not-found, 429 as backoff-with-`Retry-After`, 5xx/network as retryable.

### Hypothesis verdicts

- **H3 — REFUTED.** The skill says the `code` is "opaque and unenumerated… passed through
  from the API body". Both halves are wrong: it is **fully enumerable** (five hardcoded
  constants, listed above), it is **not** passed through from the body, and it is
  `undefined` on generic `APIRequestError`. The skill's advice ("use for telemetry, not
  control flow") lands on the right answer for the wrong reason — the code is safe for
  control flow but carries no information the HTTP status doesn't.
- **H4 — CONFIRMED [live + static].** Server-side validation failures arrive as
  `APIRequestError`, not `ValidationError`; the SDK's `ValidationError` is constructed
  nowhere in the response path. Don't write a catch branch for it on API calls.
- **H6 — structurally confirmed, magnitude pending.** `Retry-After` is read from the header
  into `RateLimitError.retryAfter`. Whether the sandbox actually emits it at 20 req/s needs
  `pnpm phase0:rate-limit` (not yet run — burns quota).

### Still pending on this unknown

- **Rate limit** — `pnpm phase0:rate-limit`.
- **409 / 5xx shapes** — not reachable synthetically; assumed Envelope A, unverified.

---

## Phase 1 — schema capture (Google) ✅

**[live]** Full call matrix against a throwaway Google account. Every response body saved
under `captures/phase1/google/` (scrubbed of credentials and personal addresses — see
"Capture hygiene" below). All eight steps returned 200.

### P1 — Custom event `id` is ACCEPTED by Google → idempotency lever confirmed

`POST /events/{acct}/{cal}` with `id: "bal393spikecustomid001"` returned **200**, and the
created event carries exactly that id. Balo can therefore derive the event id
deterministically from a consultation id and make event creation idempotent, rather than
storing a vendor-generated id and hoping a retry doesn't double-book.
⚠️ **Microsoft is expected to reject caller-supplied ids and is NOT yet tested** — don't
design on this until the Microsoft half runs.

### P2 — `privateExtendedProperties` round-trip works end to end

| Step                                                              | Result                               |
| ----------------------------------------------------------------- | ------------------------------------ |
| echoed on create                                                  | `{"baloBookingId":"spike-test-1"}` ✔ |
| queryable via `?metadataFilters={"baloBookingId":"spike-test-1"}` | matched exactly 1, the right event ✔ |
| **survives a `PUT` reschedule**                                   | ✔ (not silently dropped)             |

This is the reconciliation backbone the ticket called out, and it holds.

### P3 — ⚠️ `nextPageToken` and `nextSyncToken` are MUTUALLY EXCLUSIVE

**The single most consequential Phase-1 finding.** Proven by forcing pagination with
`pageSize=5` over a 17-event calendar:

| Page | `data` | `nextPageToken` | `nextSyncToken` |
| ---- | ------ | --------------- | --------------- |
| 1    | 5      | **present**     | absent          |
| 2    | 5      | **present**     | absent          |
| 3    | 5      | **present**     | absent          |
| 4    | 2      | absent          | **present**     |

**`nextSyncToken` is returned ONLY on the final page.** Consequences for BAL-396:

- The delta-sync design **requires paginating to exhaustion**. Stop early and you never
  receive a sync token, so incremental sync silently never starts — it degrades to a full
  window read forever, with no error anywhere. This is exactly the trap in the skill's
  Constraint 9 ("OneCal's own reference app reads only the first page — do not copy that"),
  and the cost of copying it is now concrete.
- Default page size is **400**. A calendar under 400 events returns a sync token on the
  first call, which makes the bug **invisible in dev and on small test accounts** and only
  surfaces on a busy expert's real calendar. Test with `pageSize` forced small.
- A delta read with a valid `syncToken` returned `200`, `data: []`, and the **same** token
  back when nothing had changed — so persist the returned token unconditionally.

### P4 — Captured shapes

- **`freeBusy` returns a bare ARRAY**, not a `{data}` envelope like every other list
  endpoint: `[{"calendarId":"…","busySlots":[{"start":{"dateTime","timeZone"},"end":{…}}]}]`.
  Empty window → `busySlots: []`; after creating the event the slot appeared correctly.
- **`isPrimary` is omitted entirely when false** — only the primary calendar carries
  `isPrimary: true`. A `=== false` check misclassifies every calendar; treat absent as
  false in the mapper.
- **`readOnly` is reliable** and correctly `true` on subscribed holiday calendars.
- `allowedOnlineMeetingProviders: ["hangoutsMeet"]` on every Google calendar.
- `DELETE` → `200 {"success":true}`.
- Event fields: `id, title, description, etag, createdAt, updatedAt, start, end, isAllDay,
privateExtendedProperties, isRecurring, isException, isCancelled, recurrence, webLink,
iCalUid, eventType, organizer, creator, …`

### P6 — ✅ Partial consent is rejected server-side by Apiroc **[live]**

Google's consent screen has **granular per-scope checkboxes** ("View and edit events on all
of your calendars" / "See, edit, share and permanently delete all the calendars…"). Question
was whether an expert could uncheck them, complete the flow, and leave Balo with a
connected-looking calendar that can't be read.

**Completed the flow with BOTH boxes unchecked. Apiroc rejects it at the callback:**

```
http://localhost:8787/callback?provider=GOOGLE
  &error=missing_required_permissions
  &error_description=User+did+not+grant+all+required+permissions.
```

**No `endUserAccountId` is returned and no account is created.** The vendor validates scope
grants server-side, so the half-connected-account risk is mitigated by Apiroc — Balo cannot
end up storing a live pointer to a calendar it can't read.

**But this imposes a hard requirement on the callback handler:** the OAuth callback is
**not** guaranteed to carry `endUserAccountId`. It can instead carry `error` +
`error_description`. A handler that assumes the happy shape will crash or, worse, persist
`undefined` as a connection. BAL-396 must branch on `error` first.

Note this is a **fifth** error vocabulary — and the only snake_case, genuinely enumerable one
(`missing_required_permissions`). It appears on the OAuth callback query string, nowhere else.

⚠️ **Re-consent does not re-show the checkboxes.** Once granted, Google collapses the screen
to "Apiroc already has some access", even with `prompt=consent`. To re-test a partial grant
the user must first revoke at `myaccount.google.com/permissions`. Relevant to any
"reconnect with different permissions" UX — the expert may need to revoke at Google first,
and Balo's reconnect copy should say so.

### P5 — OAuth callback shape **[live]**

Callback is `?endUserAccountId=<id>&state=<state>` — the param **is** literally
`endUserAccountId`, and `state` round-trips intact. **`http://localhost:8787/callback` was
accepted** by the dashboard allowlist and by the authorize flow — plain HTTP on localhost is
NOT rejected, so no tunnel is needed for Phase 1. (`webhookUrl` in Phase 2 still demands
HTTPS.) Passing `prompt=select_account` correctly forces the provider account chooser.

---

## Phase 1 — Microsoft ✅ and the provider-parity table

**[live]** Same matrix against a throwaway Microsoft account. Captures in
`captures/phase1/microsoft/`. **Apiroc unifies the request shape but NOT the semantics** —
every divergence below is a place an adapter written against Google alone would be wrong.

| Behaviour                                  | Google                                 | Microsoft                                        | Impact                            |
| ------------------------------------------ | -------------------------------------- | ------------------------------------------------ | --------------------------------- |
| Caller-supplied event `id`                 | **honoured** — returns the id you sent | **200 OK, silently substituted** with a Graph id | ⚠️⚠️ see M1                       |
| `nextSyncToken`                            | on the final page                      | **never returned, on any page**                  | ⚠️⚠️ see M2                       |
| `privateExtendedProperties` echoed on read | `{"baloBookingId":"spike-test-1"}`     | **`{}` — never echoed**                          | see M3                            |
| `metadataFilters` query                    | works                                  | **works** (negative-control verified)            | M3                                |
| `allowedOnlineMeetingProviders`            | `["hangoutsMeet"]`                     | `[]` — none                                      | no Teams link generation          |
| Calendar `timeZone`                        | populated (`Australia/Melbourne`)      | **absent**                                       | can't rely on it; use Balo's tz   |
| `isPrimary` on non-primary                 | **field omitted**                      | **explicitly `false`**                           | treat absent AND false as false   |
| `busySlots` timeZone label                 | `UTC`                                  | `Etc/UTC`                                        | don't string-compare tz names     |
| `dateTime` precision                       | `2026-08-20T10:00:00Z`                 | `2026-08-20T10:00:00.000Z`                       | parse, never string-compare       |
| Final page of pagination                   | last page has data + `nextSyncToken`   | emits an **extra empty page** (`count: 0`)       | one extra round-trip to terminate |
| Calendar id format                         | email address                          | 152-char opaque Graph id                         | must be URL-encoded in paths      |

### M1 — ⚠️⚠️ Microsoft silently ignores a caller-supplied event `id`

`POST` with `id: "bal393spikecustomid001"` returned **HTTP 200** — and an event whose id is
`AQMkADAwATM3ZmYBLWI3MmMtNWU3OS0wMAItMDAK…`. Not a rejection. Not an error. A **success
response that quietly did something else**.

The ticket predicted "Google accepts / Microsoft rejects". The truth is worse than a
rejection: a rejection would fail loudly in CI. This fails **silently and only in
production, only for Microsoft-based experts** — an idempotent-create-by-derived-id design
would look correct in every Google test, then double-book on every retry for Microsoft.

> This also caught a bug in **this harness**: the probe originally judged success on
> `status < 400` and reported a false pass. Fixed — it now asserts the returned id equals
> the requested one. Worth noting because it is exactly the mistake the real adapter would
> make.

**→ Caller-supplied ids are NOT a portable idempotency lever.** BAL-396 must store the
vendor-returned event id and key idempotency off Balo's own record.

### M2 — ⚠️⚠️ Microsoft never returns `nextSyncToken`

Paginated to exhaustion with `pageSize=1` over 3 events:

| Page | `data` | keys                  | `nextSyncToken` |
| ---- | ------ | --------------------- | --------------- |
| 1    | 1      | `data, nextPageToken` | ABSENT          |
| 2    | 1      | `data, nextPageToken` | ABSENT          |
| 3    | 1      | `data, nextPageToken` | ABSENT          |
| 4    | 0      | `data`                | **ABSENT**      |

A complete unpaginated list (2 events, no paging at all) likewise returned keys `data` only.
Google's identical call returns `nextSyncToken` on the final page. **There is no delta-read
mechanism for Microsoft through this API.**

This undercuts the core architecture in the skill ("webhook → `events.list({syncToken})`
delta read → recompute availability") for **half the provider base**. BAL-396 needs a
decision: full forward-window re-read on every Microsoft webhook (heavier, but correct), or
raise it with the vendor. **Do not assume parity here.**

### M3 — Tags are write-and-query only on Microsoft, never readable back

`privateExtendedProperties` came back `{}` on create, on read, and after `PUT` — and
`publicExtendedProperties` was `{}` too, so it isn't merely being relocated.

But the tag **is** persisted and **is** queryable. Verified with a negative control (the
"filter matched 1 of 1 event" result on its own proved nothing — an ignored filter returns
everything):

| Query                                              | Result                    |
| -------------------------------------------------- | ------------------------- |
| two events created, tagged `tag-AAA` and `tag-BBB` | —                         |
| `metadataFilters={"baloBookingId":"tag-AAA"}`      | → exactly `BAL393 A` ✔    |
| `metadataFilters={"baloBookingId":"tag-BBB"}`      | → exactly `BAL393 B` ✔    |
| `metadataFilters={"baloBookingId":"tag-NOPE"}`     | → `[]` ✔ (filter is real) |

**→ Reconciliation by _querying_ the tag works on both providers. Reconciliation by
_reading the tag off a fetched event_ works only on Google.** Never round-trip a Microsoft
event expecting its tag back.

---

## Unknown 2 — Credential expiry / revocation

**Question:** what account `status` becomes (`ACTIVE` / `EXPIRED` / `REVOKED`) and what
error a data call throws once the credential is dead.

### ⚠️⚠️ Answer: `credentialStatus` LIES until something has already failed. H5 is REFUTED.

**[live]** Access revoked at `myaccount.google.com/permissions` on the throwaway account.
Captures in `captures/phase2/google/`.

| Moment                       | `endUserAccounts.get().status` | `getCredentials()`                                          | `calendars.list()`          | `freeBusy`               |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- | --------------------------- | ------------------------ |
| baseline (healthy)           | `ACTIVE`                       | `200`, both tokens present                                  | `200`, 4 calendars          | `200`                    |
| **immediately after revoke** | **`ACTIVE`** ← stale           | **`200`, `ACTIVE`, both tokens STILL present** ← stale      | `401` `InvalidRefreshToken` | `403` credential expired |
| after one failed data call   | **`EXPIRED`**                  | `403` `{"error":"Error","message":"Invalid refresh token"}` | `403`                       | `403`                    |

**1. The status flip is LAZY — a data call has to fail first.** Revocation alone changed
nothing: `endUserAccounts.get()` still said `ACTIVE`, and `getCredentials()` still returned
`ACTIVE` **with both an access token and a refresh token present**, after the user had
already revoked. Only once a real calendar call failed did the status become `EXPIRED`.

> **→ Polling `endUserAccounts.get()` as a health check is worthless as a leading
> indicator.** It is a _lagging_ record of a failure you have already seen. The skill's
> Delta 2 and Error Handling sections both instruct the opposite.

**2. A user-initiated REVOKE surfaces as `EXPIRED`, not `REVOKED`.** The user clicked
"Remove access" and got `EXPIRED`. On Google, `REVOKED` looks unreachable in practice — so
**do not build distinct UX for the two states**; treat any non-`ACTIVE` value as "reconnect
required".

**3. The same condition yields different errors depending on timing.**

|                  | Pre-flip                                                                               | Post-flip                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `calendars.list` | `401` `{"error":"InvalidRefreshToken","message":"Token has been expired or revoked."}` | `403` `{"error":"Error","message":"End user account credential expired"}` |
| SDK              | `AuthenticationError` / `AUTHENTICATION_ERROR`                                         | `AuthorizationError` / `AUTHORIZATION_ERROR`                              |

⚠️ **The 401 case is genuinely dangerous.** Through the SDK, a revoked _end-user credential_
throws the **same class and code** as a bad _platform API key_ — `AuthenticationError` /
`AUTHENTICATION_ERROR`. One means "one expert must reconnect"; the other means "Balo's
calendar integration is down for everyone". They are indistinguishable except by the
`message` string, or by the wire `error` field the SDK discards.

**A fourth `error` shape — and the first genuinely useful one.**
`{"error":"InvalidRefreshToken"}` is a real machine-readable code, unlike the constant
`"Error"` or the number `404`. The field is therefore
`"Error" | 404 | "InvalidRefreshToken" | {ZodError}` depending on the failure. Ironically,
`InvalidRefreshToken` is the **exact example the skill dismisses** as "opaque and
unenumerated — use for telemetry, not control flow"; it is in fact the most reliable
revocation signal on the wire.

### What BAL-396 must do instead

1. Catch the failure on the **data call** — treat `401`+`InvalidRefreshToken` **and**
   `403`+"credential expired" as one condition: reconnect required.
2. Separate it from a platform-key failure using the wire `error`/`message`, via the
   interceptor Unknown 1 already requires.
3. Re-read `endUserAccounts.get()` **after** the failure to confirm (`EXPIRED`) and persist
   to `calendar_connections.credential_status`.
4. The `enduseraccount.credential.updated` webhook is the only possible _proactive_ signal —
   **still untested**. If it does not fire on revocation, there is no proactive path and an
   expert stays silently broken until someone tries to book them.

|                                                                        | Observed                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Does a `enduseraccount.credential.updated` webhook fire on revocation? | **No — 0 deliveries over 5.5 min, spanning both the revoke and the status flip.** See below |
| Lag between provider-side revoke and status flip                       | **Not time-based — event-based.** Flips on the first failed data call, not a timer          |

### ⚠️⚠️ There is NO proactive reconnect signal. `credential.updated` never fires.

**[live]** Tested with a **live `event` subscription in place** and the webhook receiver
running — the earlier revocation happened before any subscription existed, so it could not
have been observed then.

| Phase                                                      | Duration | Account status      | Deliveries |
| ---------------------------------------------------------- | -------- | ------------------- | ---------- |
| A — after revoking at Google, no other action              | 3 min    | `ACTIVE` throughout | **0**      |
| B — after forcing the flip with a `calendars` call (`401`) | 2.5 min  | `EXPIRED`           | **0**      |

**No `enduseraccount.credential.updated`, no `enduseraccount.updated`, nothing at all** —
neither on the revocation itself nor on the `ACTIVE → EXPIRED` transition.

Stated honestly: account-level events may only be delivered on a **`calendar`-type**
subscription, which is the type returning **HTTP 500**. So the capability might exist and be
merely unreachable. The practical conclusion is unchanged: **today there is no way to
receive a proactive credential signal.**

**→ Step 4 of the recovery design above is dead.** Detection is _purely_ error-driven.
Combined with the lazy status flip, the real-world failure is:

> An expert revokes calendar access. Balo keeps showing them as connected, `status` stays
> `ACTIVE`, no webhook arrives, nothing changes — **until a client tries to book them.** The
> failure surfaces in front of a paying client.

**This creates new work — see T14.** Balo needs a **periodic health probe**: a cheap
synthetic **data call** per connection on a schedule. Note this is _not_ the refuted "poll
`endUserAccounts.get()`" pattern — polling the status is useless precisely because the status
only moves after a data call has already failed. The probe must issue a real data call.

**Verdict on H5 — ❌ REFUTED.** "Drive reconnect off `credentialStatus`, not off error
codes" is backwards: the status is stale until an error code has already told you.

---

## Unknown 3 — Subscription lifecycle

**Question:** the `expiration` value/duration, and whether renewal is caller-managed or
automatic — i.e. **do we need a renewal job?**

### ⚠️⚠️ Answer: subscriptions DO expire — 7 days — and the create response hides it. H1 refuted.

**[live]** `captures/phase2/google/subscribe-*.json`, `subscriptions-list.json`.

|                                                                      | Observed                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Create response fields                                               | **only** `{ webhookSubscriptionId, endpointSecret }`                 |
| `expiration` **on the create response**                              | **`null`** ← the trap                                                |
| `expiration` **in the stored record** (`calendarSubscriptions.list`) | **`2026-08-21T07:36:30.000Z`**                                       |
| Created at                                                           | `2026-08-14T07:36:31.574Z`                                           |
| **Implied TTL**                                                      | **exactly 7 days**                                                   |
| Provider channel identifiers                                         | `subscriptionId` (uuid) + `resourceId` — Google `watch` channel refs |
| `endpointSecret`                                                     | present, 38 chars                                                    |

**The trap:** `CreateCalendarSubscriptionResponse` carries no `expiration` field at all, so a
caller reading only the create response sees `null` and concludes subscriptions never
expire — which is very likely how the skill's claim originated. The expiry is **only**
visible via `calendarSubscriptions.list`. 7 days matches Google's maximum `watch` channel
TTL, so Apiroc is passing the provider's channel expiry straight through.

**Verdict on H1 — ❌ REFUTED as written.** "Subscriptions don't expire" is false: they carry
a hard 7-day expiry.

⚠️ **What is still genuinely unresolved is whether Apiroc auto-renews before that expiry.**
This spike cannot settle it — it would require watching a subscription for 7 days. The two
possibilities have very different costs:

- **Apiroc auto-renews** → no renewal job; the skill's _conclusion_ was right for the wrong
  reason, and `expiration` is just a passthrough detail.
- **Renewal is caller-managed** → **BAL-396 needs a scheduled renewal job that is currently
  unplanned**, and every expert's calendar sync silently dies 7 days after connection with
  no error raised anywhere. Availability would quietly go stale platform-wide.

**Recommendation:** treat renewal as caller-managed until the vendor confirms otherwise —
the failure mode is silent and platform-wide, so the asymmetry favours building the job. Ask
the vendor directly, and add a cheap monitor either way: a daily check for subscriptions
with `expiration` inside 48h is a few lines and catches the bad case regardless of the answer.

### ⚠️ You cannot delete a subscription once the credential has expired — reconnect must come FIRST

**[live]** Two gotchas, one cosmetic and one that inverts a documented procedure.

**1. `delete` puts the id in the request BODY, not the path.** The SDK issues
`DELETE /api/v1/calendarSubscriptions/{endUserAccountId}` with `{ data: { subscriptionId } }`.
A path-style `DELETE /calendarSubscriptions/{acct}/{id}` — the obvious guess, and what this
spike tried first — returns `404 Not Found` while leaving the record untouched. DELETE-with-a-body
is unusual and some proxies and HTTP clients drop it silently, so this is worth pinning in the
adapter and never hand-rolling.

**2. Deleting is blocked on an expired credential.** With the account in `EXPIRED`, deleting
its subscriptions fails:

```
delete cmssoyzws… → AuthorizationError 403 "End user account credential expired"
delete cmssmvjh… → AuthorizationError 403 "End user account credential expired"
```

The skill's reconnect procedure — _"On reconnect, `calendarSubscriptions.delete` the old ones
and re-create"_ — **cannot execute in that order**. The credential is expired precisely
_because_ the user revoked, which is the reason you are reconnecting; so at cleanup time the
delete is already forbidden.

**→ Correct order is: reconnect first (restoring the credential), then delete the stale
subscriptions, then re-create.** This works because `endUserAccountId` is stable across a
revoke/reconnect cycle (I5), so the old subscription records are still addressable afterwards.

⚠️ **Combined with the 7-day expiry and the broken `calendar` type, this is a real accumulation
risk**: if an expert reconnects and cleanup is skipped or fails, stale subscriptions linger
until they expire — delivering duplicate webhooks and triggering duplicate delta-read jobs for
up to a week. Cleanup needs to be explicitly ordered and verified, not best-effort.

### ⚠️ The `calendar` subscription type is broken — HTTP 500

`subscriptionType: 'calendar'` (the "all calendars, no `calendarId`" variant) fails:

```json
{
  "error": "InternalServerError",
  "message": "init[\"status\"] must be in the range of 200 to 599, inclusive.",
  "requestId": "0f68403b6b1f46c91bae84ff324f4a85"
}
```

That is an unhandled exception inside Apiroc (a `Response` constructed with an invalid
status), not a validation error — the message is leaked internals. **Only `event`
subscriptions work**, so Balo must subscribe **per calendar** and there is no
all-calendars option. Combined with the 7-day expiry, that is N subscriptions per expert to
create, track, and possibly renew.

This is also a **sixth** distinct `error` value: `"InternalServerError"`.

→ Report to the vendor. Until fixed, per-calendar `event` subscriptions are the only path.

---

## Unknown 4 — Webhook payload

**Question:** the actual POST body + Svix headers; whether identity is absent (which is
what forces encoding `endUserAccountId`/`calendarId` into the per-subscription
`webhookUrl`), and whether one ping can batch multiple changes.

### ✅ Answer: H2 CONFIRMED. The payload is thin and anonymous — identity must come from the URL.

**[live]** 5 real deliveries captured verbatim in
`captures/phase2/webhooks/received.json`, received over a cloudflared tunnel.

**The complete body. This is all of it:**

```json
{ "eventType": "calendar.event.changed", "timestamp": "2026-08-14T07:37:20.129Z" }
```

|                                                    | Observed                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Headers received                                   | `svix-id`, `svix-timestamp`, `svix-signature` all present                                                              |
| Does the body carry account/calendar identity?     | **No — zero identity fields.** Programmatic scan for any key matching `account\|calendar\|resource\|id$` returned `[]` |
| Signature verifies with `svix` + `endpointSecret`? | **VALID** on every delivery, via `new Webhook(endpointSecret).verify(rawBody, headers)`                                |
| Do rapid successive changes coalesce?              | **Yes — see below**                                                                                                    |
| Event types observed                               | `calendar.event.changed` only                                                                                          |

**→ Encoding `endUserAccountId`/`calendarId` in the per-subscription `webhookUrl` is
REQUIRED, not a stylistic choice.** The receiver ran at
`/hook/:endUserAccountId/:calendarId` and the path was the _only_ way to know which expert
the ping belonged to. The skill's architecture is correct here.

### Coalescing is real — one ping ≠ one change

Eight calendar changes produced **five** deliveries:

| Changes made      | Deliveries |
| ----------------- | ---------- |
| 1 isolated create | 1          |
| 3 rapid creates   | **2**      |
| 4 rapid deletes   | **2**      |

Deliveries landed roughly one per ~10s window, so Apiroc/Google batches within that window.

**Consequences for BAL-396:**

- Never infer _what_ changed from a ping — it carries no event id. The `syncToken` delta
  read is mandatory (and on Microsoft, where there is no sync token, a full window re-read —
  see T3).
- The delta-read job must be **debounced and deduped per calendar**. Firing one job per
  webhook wastes work, and firing one job per _change_ is impossible anyway.
- Dedupe on `svix-id` as the skill says — every delivery had a distinct one
  (`msg_3Htgz…`, `msg_3Hth1…`, …), so it is a usable idempotency key.
- Ack fast: the receiver returned `200` immediately and Svix never retried.

**Verdict on H2:** _(pending)_ — if identity **is** present, the `webhookUrl`-encoding
workaround in the skill's architecture sketch is unnecessary complexity.

---

## Incidental findings

_Things learned that no unknown asked about — dashboard quirks, doc/SDK drift, rejected
redirect URIs, undocumented fields._

- **I1 — The SDK logs to the console itself, and it cannot be silenced. [static]**
  It builds a module-level `winston` logger with an unconditional `Console` transport and
  logs **every** API error at `error` level (`logger.error("API Error", {...})`), plus
  request/response at `debug`. Level comes from `process.env.LOG_LEVEL` (default `info`),
  and since `error` is winston's level 0, **no `LOG_LEVEL` value suppresses the error
  logs**. This directly conflicts with CLAUDE.md's logging rules: the lines bypass Pino,
  so they carry no `requestId`/`userId` and won't reach Axiom as structured logs — while
  still polluting stdout on Railway. BAL-396 needs a decision (patch the logger, wrap the
  SDK, or accept duplicate noise). Observed live during the 401 probe.

- **I2 — `getCredentials()` returns raw provider tokens. [static]**
  `EndUserAccountCredential` exposes `accessToken`, `refreshToken` and (Apple) `password`.
  The skill's "vendor holds the tokens, we never store them" posture is a _choice we must
  keep making_, not something the API enforces — these fields will be sitting in memory on
  every `getCredentials` call. Never log the object, never persist it, and prefer
  `endUserAccounts.get()` (which returns only `status`) when all you need is the status.

- **I5 — Reconnect REUSES the same `endUserAccountId`. [live]** After the revoke →
  reconnect cycle, the callback returned the **same** id (`cmssf6bh…`); the account's
  `createdAt` was unchanged while `updatedAt` moved. Apiroc keys the record on
  (app, provider, email), so the pointer Balo stores is **stable across a
  revoke/reconnect** — reconnect is an UPDATE, not an INSERT, and no orphaned row is left
  behind. Good news for `calendar_connections`: no id churn to reconcile.
  ⚠️ Whether **webhook subscriptions** survive that same cycle is a separate question — the
  skill says to delete and re-create them on reconnect. Untested; add to Phase 2 (T11).

- **I3 — Hardcoded stale `User-Agent`. [static]** v2.0.1 sends
  `unified-calendar-api-node-sdk/0.1.0`. Vendor-side telemetry can't tell our SDK version,
  so don't rely on the vendor identifying our client version during support.

- **I4 — `subscriptionType` is required. [static]** See Finding 0 — the skill's example
  call would now fail. It also confirms `calendar` vs `event` are the two subscription
  kinds the ticket asks Phase 2 to compare.

- **Redirect URI:** dashboard field is _Application Details → Authorized Redirect URIs_
  (confirmed against the dashboard). Whether `http://localhost:8787/callback` is accepted
  there: _(pending)_ — rejection forces a tunnel for Phase 1 as well as Phase 2.
  Separately, `CreateCalendarSubscriptionInput.webhookUrl` is documented **"Must be a valid
  HTTPS URL"** **[static]**, so Phase 2 needs a real HTTPS receiver regardless.

---

## Capture hygiene

Everything under `captures/` passes through one scrubber in `src/lib.mjs` before it touches
disk. Three classes of data are stripped, and the reasons are worth knowing because the same
hazards apply to production logging:

1. **Credentials** — `accessToken`, `refreshToken`, `password`, `endpointSecret` are replaced
   with a type/length marker at any depth, including inside the `bodyRaw` JSON _string_
   (where key-based redaction would otherwise sail straight past them). `getCredentials()`
   really does hand back live Google tokens — see I2.
2. **Personal email addresses** — the expert's own **and any third party's**. A throwaway
   calendar still contained a real meeting invite from an outside organiser; their address
   is their PII, not ours to commit. Google calendar ids and iCalUIDs are shaped like
   addresses but are opaque machine ids, so those are kept — they carry real schema signal.
3. **The API key**, swept from the serialised text as a second pass.

The first pass of captures was taken before this existed and contained live OAuth tokens and
a third party's address. They were regenerated, not hand-edited. **If you re-run the harness,
re-run the scan** — `grep -rE '"(accessToken|refreshToken)":"[A-Za-z0-9_./-]{20,}' captures/`
and a sweep for non-`@google.com` addresses.

---

## Handoff — work this spike creates

**For the reviewer:** each block below is scoped to become one Linear issue. Titles are
final-form; "Parent/relation" says whether it amends an existing ticket or is new. Every
claim is backed by a capture in `captures/` — cite the referenced section when writing the
issue so the next person doesn't re-derive it. Priority is relative to the calendar
workstream, not the whole backlog.

Do **not** build the adapter or touch `tests/invariants/` off the back of this document.

---

### T1 — Wrap the Apiroc SDK in an error interceptor that preserves `requestId` and the raw body

- **Relation:** amends **BAL-396** (blocking sub-task — everything else in the adapter
  depends on error handling existing)
- **Priority:** Urgent
- **Evidence:** Unknown 1 · `captures/phase0/*`

**Problem.** The SDK destroys the information needed to debug or branch. On a `400` it
discards the entire Zod validation payload and reports the generic
`"Request failed with status code 400"`; `.code` and `.details` are `undefined` because the
interceptor reads `data.code` while the API sends `data.error`. `x-request-id` is present on
every response header and is copied nowhere, so vendor support escalation has nothing to
quote.

**Scope.** An axios response interceptor (or call wrapper) that, before the SDK's own
interceptor runs, captures the `x-request-id` header and the raw response body, attaches
both to the thrown error, and logs them via Pino.

**Acceptance criteria**

- Every thrown Apiroc error carries `requestId`.
- On a `400`, the Zod issue array is recovered (`JSON.parse(body.error.message)`) and logged
  with field paths.
- Branching is on **HTTP status only** — no code in the adapter reads the wire `error` field
  as an enum. (It is variously `"Error"`, `404`, `"InvalidRefreshToken"`, or a ZodError
  object.)
- `instanceof` checks are ordered most-specific-first (all four subclasses extend
  `APIRequestError`); nothing branches on `error.constructor.name` (bundler-mangled to
  `_AuthenticationError`).
- Retry policy: `400` never, `401/403` never (reconnect — see T2), `429` honour
  `retryAfter`, `5xx`/network yes.

---

### T2 — Reconnect detection must be error-driven, not `credentialStatus`-driven

- **Relation:** amends **BAL-396**; **corrects a design rule currently in the skill**
- **Priority:** Urgent
- **Evidence:** Unknown 2 · `captures/phase2/google/revocation-*.json`

**Problem.** After a user revokes access at Google, `endUserAccounts.get()` still returns
`ACTIVE` and `getCredentials()` still returns `ACTIVE` **with both tokens present**. The
status only flips to `EXPIRED` after a data call has already failed. Health-polling the
account is therefore worthless as a leading indicator, and the skill's rule ("drive
reconnect off `credentialStatus`, never off error codes") is backwards.

**Scope.** Detect reconnect-required from the data-call failure, then confirm and persist.

**Acceptance criteria**

- `401` + wire `error: "InvalidRefreshToken"` **and** `403` + `"End user account credential
expired"` both map to one internal `RECONNECT_REQUIRED` condition.
- A revoked **expert credential** is distinguished from a bad **platform API key** — both
  throw `AuthenticationError`/`AUTHENTICATION_ERROR` on the pre-flip 401 and differ only by
  message/wire field. Misclassifying this turns "one expert must reconnect" into "the
  integration is down for everyone" (or hides the reverse).
- On detection, re-read `endUserAccounts.get()` and persist the resulting status to
  `calendar_connections.credential_status`.
- **No distinct UX for `EXPIRED` vs `REVOKED`** — a user-initiated revoke yields `EXPIRED`;
  `REVOKED` appears unreachable on Google. Treat any non-`ACTIVE` as reconnect-required.
- No scheduled job polls account status as a health check (see T14 — the probe must make a
  real **data** call).
- **Reconnect ordering:** reconnect FIRST, then delete stale subscriptions, then re-create.
  Deleting is forbidden while the credential is `EXPIRED`, so the skill's delete-then-recreate
  order cannot run. Cleanup must be verified, not best-effort — stale subscriptions deliver
  duplicate webhooks for up to 7 days.

---

### T3 — Microsoft has no delta-sync: decide the fallback before building the webhook path

- **Relation:** **new**, blocks **BAL-396**
- **Priority:** Urgent — architectural, and it invalidates the current design for half the
  provider base
- **Evidence:** Phase 1 Microsoft §M2 (paginated to exhaustion, `pageSize=1`)

**Problem.** Microsoft **never** returns `nextSyncToken` — not on any page, not on a
complete unpaginated list. Google returns it on the final page. The architecture in the
skill ("webhook → `events.list({syncToken})` delta read → recompute availability") has no
delta mechanism on Microsoft.

**Scope.** A decision, then implementation of whichever branch is chosen:

1. Full forward-window re-read on every Microsoft webhook (correct, heavier — size the cost
   against Microsoft's 1000/min per-account limit), **or**
2. Raise with the vendor and block on a fix, **or**
3. `updatedAfter` as a poor-man's delta — **unverified**, would need its own probe.

**Acceptance criteria**

- Decision recorded (ADR or ticket comment) with the chosen fallback and its cost.
- Provider-conditional sync path implemented and tested against both providers.
- A test that fails if someone later assumes sync-token parity.

---

### T4 — Paginate `events.list` to exhaustion; never trust page 1

- **Relation:** amends **BAL-396**
- **Priority:** High
- **Evidence:** Phase 1 §P3

**Problem.** On Google, `nextSyncToken` is returned **only on the final page**. Stop early
and no sync token is ever obtained, so incremental sync silently never starts and degrades
to a full-window read forever — with no error anywhere. Default page size is **400**, so any
calendar under 400 events returns the token on the first call: **the bug is invisible in dev
and on test accounts, and only appears on a busy expert's real calendar.**

**Acceptance criteria**

- The sync read follows `nextPageToken` to exhaustion and persists `nextSyncToken`
  unconditionally (a no-change delta returns the same token — that is correct, not a bug).
- A test with a forced small `pageSize` proves the token is captured across >1 page.
- Microsoft's extra trailing empty page (`count: 0`) terminates the loop cleanly.

---

### T5 — Do not use caller-supplied event ids for idempotency

- **Relation:** amends **BAL-396**
- **Priority:** High
- **Evidence:** Phase 1 Microsoft §M1 · `captures/phase1/*/04a-create-custom-id.json`

**Problem.** Google honours a caller-supplied event `id`. **Microsoft returns HTTP 200 and
silently substitutes its own Graph id.** Not a rejection — a success response that quietly
did something else. An idempotent-create-by-derived-id design passes every Google test, then
double-books on retry for Microsoft experts, in production only.

**Acceptance criteria**

- Event creation stores the **vendor-returned** id on the consultation record.
- Idempotency is keyed off Balo's own record, not off a derived vendor id.
- If a derived id is used anywhere, the returned id is asserted equal to the requested one
  and the mismatch is treated as an error. (This spike's own harness had exactly this bug —
  it judged the probe on `status < 400` and reported a false pass.)

---

### T6 — Microsoft tags are write-and-query-only; never read them back off an event

- **Relation:** amends **BAL-396**
- **Priority:** Medium
- **Evidence:** Phase 1 Microsoft §M3 (negative-control verified)

**Problem.** On Microsoft, `privateExtendedProperties` returns `{}` on create, on read, and
after `PUT` (and `publicExtendedProperties` too — it isn't relocated). The tag **is**
persisted and **is** queryable via `metadataFilters`; it is simply never echoed.

**Acceptance criteria**

- Reconciliation queries by tag (works on both providers); nothing reads the tag off a
  fetched Microsoft event.
- Provider-parity table from this document is encoded as tests or mapper guards:
  `isPrimary` omitted (Google) vs explicit `false` (Microsoft); `UTC` vs `Etc/UTC`;
  millisecond precision; Microsoft calendar ids are 152-char opaque strings needing URL
  encoding; Microsoft has no calendar `timeZone` and no `allowedOnlineMeetingProviders`.

---

### T7 — Connect flow: pre-consent scope notice + `missing_required_permissions` recovery

- **Relation:** **new** (connect-flow UX; relates to **BAL-396** and **BAL-394**)
- **Priority:** High
- **Evidence:** Phase 1 §P6 · `captures/phase1/oauth-callback.json`

**Problem.** Google's consent screen uses granular per-scope checkboxes and **every box is
unchecked by default, including "Select all"**. Anyone who clicks Continue without reading
grants nothing. Apiroc correctly rejects the partial grant server-side — no account is
created — but it returns the user to Balo's callback with
`?error=missing_required_permissions&error_description=...` **and no `endUserAccountId`**.

**Scope.** Two pieces:

1. **Callback handler must branch on `error` first.** It is not guaranteed to carry
   `endUserAccountId`; a handler assuming the happy shape will crash or persist `undefined`
   as a live connection.
2. **Copy** — pre-consent notice and a recovery state. Draft, subject to design review
   (gender-neutral, warm, non-adversarial per CLAUDE.md):
   - _Before redirect:_ "On the next screen, Google will ask which permissions to grant.
     **Tick both boxes** — we need them to read your availability and add consultations to
     your calendar."
   - _On error:_ "**Calendar access wasn't granted.** Google needs both permissions ticked
     before we can check your availability. Nothing was saved — you can try again and select
     both." + retry CTA.
   - _Reconnect:_ once granted, Google collapses the screen to "Apiroc already has some
     access" and **will not re-show the checkboxes, even with `prompt=consent`**. Fixing a
     partial grant requires revoking at `myaccount.google.com/permissions` first — reconnect
     copy must say so or the expert loops.

**Acceptance criteria**

- Callback handles `error`, `endUserAccountId`, and neither.
- Partial-grant attempt never creates a `calendar_connections` row.
- All three copy states implemented; reconnect state names the Google revoke step.

---

### T8 — BYOC: review consent-screen branding and scope wording

- **Relation:** amends **BAL-394** (Register Google + Microsoft OAuth apps — BYOC)
- **Priority:** Medium
- **Evidence:** Phase 1 §P6 (screenshot context), Microsoft scope list in
  `captures/phase1/microsoft/01-account.json`

**Problem.** On shared sandbox credentials the consent screen reads **"Apiroc wants access
to your Google Account"** — a third-party name experts have never heard of — directly beside
_"See, edit, share and permanently delete all the calendars that you can access using Google
Calendar."_ That pairing is a plausible source of consent drop-off well beyond the checkbox
default.

**Scope.** When registering Balo's own OAuth apps, establish: does BYOC put Balo's name and
logo on the consent screen, and can the requested scope set be narrowed (does Apiroc
function with `calendar.events` alone, without full `calendar`)?

**Acceptance criteria**

- Consent screen shows Balo branding.
- Minimum viable scope set determined and documented — or explicitly recorded as
  vendor-fixed if it cannot be narrowed.
- Microsoft equivalent checked: current scopes are `Calendars.ReadWrite` **without**
  `.Shared`, so shared/delegate calendars are likely invisible to Microsoft experts —
  confirm whether that is acceptable.

---

### T9 — Decide how to handle the SDK's own winston console logging

- **Relation:** amends **BAL-396**
- **Priority:** Medium
- **Evidence:** Incidental finding I1

**Problem.** The SDK builds a module-level winston logger with an unconditional `Console`
transport and logs **every** API error at level `error`. Because `error` is winston's level
0, **no `LOG_LEVEL` value suppresses it**. These lines bypass Pino, carry no
`requestId`/`userId`, never reach Axiom as structured logs, and duplicate noise on Railway —
in direct conflict with CLAUDE.md's logging rules.

**Acceptance criteria** — one of: patch/replace the logger at import, wrap the SDK behind a
boundary that owns all logging, or accept and document the duplication with a rationale.

---

### T10 — Rewrite the calendar skill against captured behaviour

- **Relation:** **BAL-395** (already scoped as the skill rewrite)
- **Priority:** High — every other ticket here cites it as the source of truth
- **Evidence:** whole document; hypothesis table at the top

**Required corrections** (each currently asserts something the captures refute):

| Skill claim                                                               | Correction                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| SDK is `@onecal/…@1.2.2`                                                  | **Deprecated.** Now `@apiroc/unified-calendar-api-node-sdk@2.0.1`. Base URL `https://api.apiroc.com`.          |
| `calendarSubscriptions.create(id, {calendarId, webhookUrl, rateLimit?})`  | `subscriptionType: 'calendar' \| 'event'` is now **required**                                                  |
| Error `code` is "opaque, unenumerated, passed through from the body" (H3) | **Refuted.** Hardcoded per status class; `undefined` on `APIRequestError`; the body has no `code` field at all |
| "Drive reconnect off `credentialStatus`, not error codes" (H5)            | **Refuted.** Status is stale until a data call fails — see T2                                                  |
| Architecture: webhook → `events.list({syncToken})` delta read             | **Google only.** Microsoft has no sync token — see T3                                                          |
| Constraint 9 "paginate"                                                   | Strengthen: the sync token is **only** on the final page — see T4                                              |
| `privateExtendedProperties` tagging                                       | Add: Microsoft never echoes them; query-only — see T6                                                          |
| `ValidationError` never thrown (H4)                                       | ✅ correct, keep                                                                                               |
| Rate limits                                                               | `Retry-After` → `RateLimitError.retryAfter` confirmed structurally; sandbox magnitude still unverified         |

Add the provider-parity table (Phase 1 Microsoft §) verbatim — it is the highest-value
artefact for anyone writing calendar code.

---

### T12 — Subscriptions expire in 7 days: build the renewal job (or prove it's unnecessary)

- **Relation:** amends **BAL-396**
- **Priority:** Urgent — silent, platform-wide failure mode
- **Evidence:** Unknown 3 · `captures/phase2/google/subscriptions-list.json`

**Problem.** A subscription's stored record carries `expiration` exactly **7 days** after
creation. The **create response does not include the field at all**, so a caller reading only
that response sees nothing and concludes subscriptions are permanent — almost certainly how
the skill's "they don't expire" claim arose. Whether Apiroc auto-renews before expiry is
**unconfirmed** and cannot be settled without a 7-day observation.

If renewal is caller-managed and we don't build it, every expert's calendar sync stops a week
after they connect, with **no error surfaced anywhere** — availability silently goes stale
platform-wide.

**Scope**

1. Ask the vendor directly whether provider channels are auto-renewed.
2. Build the renewal sweep unless the answer is a clear yes — the asymmetry favours building
   it (cheap job vs silent platform-wide degradation).
3. **Regardless of the answer**, add a monitor: a daily check for subscriptions whose
   `expiration` falls inside 48h, alerting if any are found. It's a few lines and it catches
   the bad case either way.

**Acceptance criteria**

- `calendar_connections` (or a subscriptions table) persists `expiration`; it is read from
  `calendarSubscriptions.list`, **never** from the create response.
- Monitor in place and alerting.
- Vendor's answer recorded on the ticket.

---

### T13 — Report two vendor bugs to Apiroc

- **Relation:** **new** — vendor liaison, not code
- **Priority:** Medium (but T13a blocks a design option in T12)
- **Evidence:** Unknown 3, Unknown 1

**T13a — `subscriptionType: 'calendar'` returns HTTP 500.** The all-calendars subscription
variant is unusable:

```json
{
  "error": "InternalServerError",
  "message": "init[\"status\"] must be in the range of 200 to 599, inclusive."
}
```

That is an unhandled exception (a `Response` built with an invalid status), leaking
internals. Consequence: Balo must create **one `event` subscription per calendar**, so with
the 7-day expiry that is N subscriptions per expert to create, track and renew.

**T13c — subscription deletion is blocked on an expired credential.** `403 "End user account
credential expired"`. This makes the documented reconnect cleanup order impossible and risks
stale subscriptions delivering duplicate webhooks for up to 7 days. Ask whether delete can be
permitted on a dead credential (it mutates Apiroc's own record, not the provider's calendar).

**T13b — the API's error contract is not a contract.** The `error` field is variously the
string `"Error"`, the number `404`, `"InvalidRefreshToken"`, `"InternalServerError"`, a
`ZodError` object, or (on the OAuth callback) `missing_required_permissions`. Ask for a
stable machine-readable code, and for `requestId` to be included in the 400-shaped envelope
(it currently appears only in the `x-request-id` header there).

---

### T14 — Periodic calendar-connection health probe (there is no proactive signal)

- **Relation:** amends **BAL-396**; **replaces** the dead step 4 of T2
- **Priority:** Urgent — this is the difference between finding out ourselves and finding out
  in front of a paying client
- **Evidence:** Unknown 2 · 0 deliveries across 5.5 min spanning a revoke and a status flip

**Problem.** Three findings compose into one bad outcome:

1. `credentialStatus` does not flip on revocation — only after a data call has already failed.
2. `enduseraccount.credential.updated` **never fires** (verified with a live subscription).
3. Therefore nothing tells Balo an expert's calendar has died.

An expert revokes access; Balo shows them as connected indefinitely; the first thing that
notices is a **client trying to book them**.

**Scope.** A scheduled job issuing a cheap **data call** per live connection (`calendars.list`
is the lightest known-good probe), mapping the failure through T2's classifier, and flipping
`calendar_connections.credential_status` + triggering reconnect notification.

**Acceptance criteria**

- Probes every live connection on a schedule; cadence justified against the per-account rate
  limits (Google 600/min, Microsoft 1000/min) and expert count.
- Uses a **data call**, not `endUserAccounts.get()` — polling status cannot work (Unknown 2).
- On failure: persist the new status and publish the reconnect notification via
  `notificationEvents.publish()` (never send email directly — CLAUDE.md).
- A dead credential is detected by the probe, **not** by a booking attempt. Worth an explicit
  test.
- Re-check whether `credential.updated` has started working once T13a (the `calendar`
  subscription 500) is fixed — if it ever fires, this job can be relaxed, not removed.

---

### T11 — Remaining spike leftovers (small)

- **Relation:** **BAL-393** remainder
- **Priority:** Medium — all four unknowns are answered; these are gap-fills
- **Evidence:** see each item

Phases 0–2 are complete. Three measurable things were **not** run, each cheap:

1. **Does `enduseraccount.credential.updated` fire on revocation?** — **the one that
   matters.** It is the only possible _proactive_ reconnect signal (T2); without it an
   expert stays silently broken until someone tries to book them. Costs one more
   revoke/reconnect cycle on the throwaway account **with a live subscription in place**
   (the earlier revocation happened before any subscription existed, so it could not have
   been observed). Harness is ready: `src/webhook-receiver.mjs` + `src/subscribe.mjs`.
2. **Sandbox rate limit** — `pnpm phase0:rate-limit`. Confirms H6's 20 req/s and whether
   `Retry-After` is actually emitted. ~2 minutes; burns sandbox quota.
3. **Do subscriptions survive a reconnect?** The account id is stable across
   revoke/reconnect (I5), but the skill says to delete and re-create subscriptions on
   reconnect. Untested, and it interacts with T12's renewal design.

Not resolvable by any spike: **whether Apiroc auto-renews before the 7-day expiry** — that
needs either a 7-day observation or a vendor answer. Tracked in T12/T13.
