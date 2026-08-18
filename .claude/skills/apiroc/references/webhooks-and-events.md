# Apiroc webhooks & consultation event writes

Depth material for the two halves of Apiroc that touch Balo's own data flow: **inbound** change
webhooks (Svix delivery, verification, the subscription lifecycle) and **outbound** consultation
event writes (create, tag, update, delete, reconcile). Read it when you are actually writing the
code — SKILL.md carries the _why_ and the vendor-wide rules, this file carries the _how_, the
verbatim payloads, and the traps that only appear at the keyboard. It assumes you have read
SKILL.md's [Webhooks](../SKILL.md), [Subscriptions & lifecycle](../SKILL.md), and
[Provider-parity table](../SKILL.md) sections; it does not repeat the hypothesis ledger.

Evidence tags follow SKILL.md: **[live]** = observed against the real API in the BAL-393 spike
(response saved under `spikes/apiroc-probe/captures/` on branch
`yomi/bal-393-spike-validate-apiroc-onecal-calendar-api-runtime-behaviour`, **not merged**);
**[stat]** = read out of the published SDK bundle (`@apiroc/unified-calendar-api-node-sdk@2.0.1`);
**[docs]** = vendor documentation only, unverified. Untagged prose is a Balo design rule.

---

## ⚠ Almost none of this is built yet. Know what you are looking at.

Both halves are **design + evidence**, not shipped code. Every code block below that is not
attributed to a real file is **the intended shape**, not something you can go and read.

| Piece                                                          | State today                                                                                         | Ticket  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| Apiroc SDK singleton + error boundary (`callApiroc`)           | **Shipped, INERT** — `apps/api/src/lib/apiroc/` (no live caller)                                    | BAL-467 |
| `calendar_connections.end_user_account_id` + index             | **Shipped**, nullable; written by nobody yet                                                        | BAL-467 |
| `findConnectionsByEndUserAccountId`                            | **Shipped, INERT** — `packages/db/src/repositories/calendar.ts`                                     | BAL-467 |
| Apiroc connect / free-busy / **event writes**                  | **Not built**                                                                                       | BAL-396 |
| Apiroc **webhook route**, subscription CRUD, renewal           | **Not built**                                                                                       | BAL-468 |
| `calendar_subscriptions` table                                 | **Does not exist.** SKILL.md's DB block is the target shape; `schema/calendar.ts` has no such table | BAL-468 |
| `svix` package                                                 | **Not a dependency** of `apps/api`                                                                  | BAL-468 |
| Vendor liaison (auto-renew answer, the 500, delete-on-expired) | **Open**                                                                                            | BAL-455 |

⚠ **`apps/api/src/routes/calendar/webhook.ts` is the CRONOFY handler, not an Apiroc one.** It
serves `POST /webhooks/cronofy`, parses a `{ notification, channel }` body, resolves identity from
`channel.channel_id`, and **performs no signature verification of any kind** — its only guard is
string equality between the body's `channel.callback_url` and `${API_BASE_URL}/webhooks/cronofy`.
That guard is not authentication (the body is attacker-supplied in its entirety) and it has no
Apiroc analogue anyway: the Apiroc body has two fields and neither is a URL. **Do not use that file
as the template.** The shipped template for a verified webhook is `apps/api/src/routes/daily/` —
see [A3](#a3--verification-and-idempotency).

⚠ SKILL.md's Architecture Summary sketches the Apiroc inbound flow in present tense
("verify with svix … dedupe on svix-id … ack 2xx"). That is the **design**, adopted from the
BAL-393 captures. No route implements it.

---

# Part A — Inbound: change webhooks

## A1 · The subscription model

**One subscription per (End User Account, calendar), of type `event`. There is no account-wide
option.** `subscriptionType: 'calendar'` — the "all calendars, no `calendarId`" variant — returns
HTTP 500 **[live]**, an unhandled vendor exception that leaks internals (SKILL.md Constraint 13,
reported as BAL-455):

```json
{
  "error": "InternalServerError",
  "message": "init[\"status\"] must be in the range of 200 to 599, inclusive.",
  "requestId": "dbecfe42683ee4ea81864064e546cc19"
}
```

So an expert with four calendars and conflict-checking on three of them needs **three
subscriptions**, each with its own `webhookUrl`, its own `endpointSecret`, and its own 7-day clock.
Multiply by providers: an expert connected to both Google and Microsoft holds two End User Accounts
(one `calendar_connections` row each — see the `(expertId, provider)` uniqueness in
`packages/db/src/schema/calendar.ts`) and therefore two independent sets.

The create call **[stat + live]**:

```typescript
// Intended shape — BAL-468. Every SDK call goes through `callApiroc` (BAL-467 §4).
const { webhookSubscriptionId, endpointSecret } = await callApiroc(
  'calendarSubscriptions.create',
  () =>
    getApirocClient().calendarSubscriptions.create(endUserAccountId, {
      calendarId, // REQUIRED for subscriptionType 'event'
      webhookUrl, // MUST be HTTPS [stat: "Must be a valid HTTPS URL"]
      subscriptionType: 'event', // REQUIRED in v2 — omitting it is a 400
      // rateLimit?: number  // messages/sec, min 1; omitted = no limit [stat]
    })
);
```

The complete response body, verbatim from `captures/phase2/google/subscribe-event.json` **[live]**:

```json
{ "webhookSubscriptionId": "cmssoyzws1qs2oi2k08up0zjo", "endpointSecret": "«38 chars — REDACTED»" }
```

Two fields. That is all of it — see [A5](#a5--the-7-day-expiry-and-renewal) for the field that is
_not_ there.

**What Balo must store per subscription** (the table is BAL-468; SKILL.md's `calendarSubscriptions`
Drizzle block is the target shape):

| Column                    | Source                                | Notes                                                      |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `connection_id`           | ours                                  | FK → `calendar_connections`, so identity survives a rename |
| `calendar_id`             | the calendar you subscribed           | Microsoft's is a 152-char opaque Graph id                  |
| `webhook_subscription_id` | create response                       | the id you pass to `delete`                                |
| `endpoint_secret`         | create response                       | **encrypted at rest** — see below                          |
| `expiration`              | **`calendarSubscriptions.list` only** | never from the create response                             |

**`endpoint_secret` at rest.** Reuse the shipped cipher — `encryptCalendarToken` /
`decryptCalendarToken` in `apps/api/src/lib/calendar-encryption.ts` (AES-256-GCM, key derived by
SHA-256 from `CALENDAR_ENCRYPTION_KEY`, stored as `iv:authTag:ciphertext` in base64). The function
names say "token" but they cipher an arbitrary string; do not write a second one, and do not invent
a second env key. The secret is the _only_ thing standing between a guessed URL and a forged
availability rebuild, so it never lands in a log line, an analytics property, or an error body.

## A2 · ⚠⚠ Identity is in the URL, not the body

**The complete webhook body [live]** — all five captured Svix deliveries in
`captures/phase2/webhooks/received.json` are byte-identical in shape:

```json
{ "eventType": "calendar.event.changed", "timestamp": "2026-08-14T07:37:20.129Z" }
```

Two fields. A programmatic scan of every delivery for any key matching
`account|calendar|resource|id$` returned `[]` **[live]**. There is **no account id, no calendar id,
no event id, and no subscription id anywhere in the body or in any non-Svix header.** The Svix
headers identify the _message_, not the _subject_.

**→ Encoding identity in the per-subscription `webhookUrl` is REQUIRED, not stylistic.** The path is
the only thing that tells you whose calendar changed. The spike's receiver ran at
`/hook/:endUserAccountId/:calendarId` and confirmed the path is the sole carrier; the stored
subscription record echoes the URL back verbatim, so `calendarSubscriptions.list` doubles as a way
to audit what you registered **[live]**:

```json
{
  "id": "cmssoyzws1qs2oi2k08up0zjo",
  "provider": "GOOGLE",
  "url": "https://…/hook/cmssf6bhg1pnwoi2k3ovlula8/yomikadri2023%40gmail.com",
  "expiration": "2026-08-21T08:35:11.000Z",
  "subscriptionId": "ebd61d9d-24d1-4420-88cf-f692050fa4ad",
  "resourceId": "5EQ4IJ7ysJwnY5WnOFhVBThVsdk",
  "calendarId": "«email-redacted»",
  "endUserAccountId": "cmssf6bhg1pnwoi2k3ovlula8",
  "createdAt": "2026-08-14T08:35:12.077Z",
  "updatedAt": "2026-08-14T08:35:12.077Z"
}
```

### A safe URL scheme

Put **our own subscription row id** in the path, not the vendor's identifiers:

```
https://api.balo.expert/webhooks/apiroc/calendar/:calendarSubscriptionId
```

| Property                                  | Why it matters                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| One opaque UUID, no vendor ids            | A Microsoft calendar id is 152 chars of Graph base64 — path-length and encoding pain for nothing               |
| Nothing to URL-encode                     | The spike had to `encodeURIComponent` a Google calendar id (an email address) into its path                    |
| Resolves in **one** indexed read          | The row carries `connection_id` → `expert_profile_id`, `calendar_id`, and the `endpoint_secret` to verify with |
| Leaks nothing if the URL is seen          | A vendor id in a URL is an identifier for an external system; a Balo row id is meaningless outside Balo        |
| Survives a calendar rename / re-subscribe | Renewal writes a new row (and a new URL); the old row can be retired independently                             |

If you instead key the URL on `endUserAccountId`, note that `findConnectionsByEndUserAccountId`
**returns an array on purpose** — `cal_conn_end_user_account_idx` is deliberately non-unique because
nothing establishes that one End User Account maps to at most one Balo expert (two experts
connecting the same Google account is routine in dev and seed data). You would have to fan out.

### ⚠⚠ Tamper posture — get the ordering right

**The URL is attacker-guessable. The signature is what authenticates. In that order.**

1. A webhook URL is not a secret. It travels to the vendor, sits in the vendor's dashboard, is
   echoed back by `calendarSubscriptions.list`, and appears in proxy and CDN logs. Assume it is
   known.
2. Therefore the path tells you **which secret to load**, and nothing more. It is a _lookup key_,
   never a credential. A handler that acts on a well-formed path before verifying has no
   authentication at all.
3. The `endpointSecret` is the credential. Svix verification over the raw bytes proves the delivery
   came from the holder of that secret, i.e. Apiroc. Signature verified on every real delivery
   **[live]**.
4. Consequence: **load the secret, verify, and only then read anything out of the path or the body.**
   A forged POST to a guessed URL must fail at step 3 with zero side effects — no DB write, no
   enqueue, no analytics event, no `lastSyncedAt` bump.
5. Corollary: a **per-subscription** secret means a compromised secret compromises exactly one
   calendar's trigger, not the platform. That is the reason not to collapse to one global secret
   even though it would be simpler.

⚠ The worst case here is not dramatic — the only effect a forged ping can buy is an availability
rebuild for one expert, which is idempotent and coalesced. But the same route is the natural place
to hang future effects, and the guard has to be right before those arrive.

## A3 · Verification and idempotency

### The raw-body trap (this is real, and it has bitten this repo before)

Signature verification is over the **exact bytes Fastify received**. `JSON.parse` followed by
`JSON.stringify` does not reproduce them — key order and whitespace both move — so the body must be
captured before any content-type parser touches it. The shipped mechanism is `fastify-raw-body`,
registered **scoped**. Copy `apps/api/src/routes/daily/index.ts` (itself copied from
`apps/api/src/routes/stripe/index.ts`) exactly:

```typescript
// apps/api/src/routes/daily/index.ts — the shipped pattern, verbatim
await fastify.register(rawBody, {
  field: 'rawBody',
  global: false, // ⚠⚠ a GLOBAL registration corrupts JSON parsing on every other route
  encoding: false, // ⚠ yields a Buffer — load-bearing, not a detail
  runFirst: true, // ⚠ capture before any other content-type parser sees it
  routes: ['/webhooks/daily'],
});
```

Four traps in four lines:

| Trap                                  | Symptom if you get it wrong                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `global: true` (or omitted)           | Every other route in the app silently changes body-parsing behaviour — platform-wide break |
| `encoding` left as a string           | Signature fails intermittently, only on bodies whose re-encode differs                     |
| `runFirst` omitted                    | Another parser consumes the stream first; `request.rawBody` is empty                       |
| Route missing from the `routes` array | `request.rawBody` is `undefined` at runtime; TypeScript is perfectly happy                 |

⚠ **And the fifth, which only fails in tests:** a test that builds the app without registering the
same scoped plugin gets `request.rawBody === undefined`, so every assertion runs against a handler
that bailed at the guard — a green suite proving nothing. `apps/api/src/routes/daily/webhook.test.ts`
carries an explicit comment about exactly this and re-registers the plugin in `beforeAll`. Do the
same.

### Verification

```typescript
// Intended shape — BAL-468. `svix` is not yet a dependency of apps/api.
import { Webhook } from 'svix';

const wh = new Webhook(decryptCalendarToken(row.endpointSecret));
wh.verify(rawBody, {
  'svix-id': headers['svix-id'],
  'svix-timestamp': headers['svix-timestamp'],
  'svix-signature': headers['svix-signature'],
}); // throws on a bad signature or a stale timestamp
```

All three headers were present on every real delivery, and verification with the per-subscription
secret was `VALID` every time **[live]**. Observed values look like
`svix-id: msg_3HtgzMfGgWuizxqYyI5IcsFymLA`, `svix-timestamp: 1786693040` (unix seconds),
`svix-signature: v1,B2gkSaR6aSoBqRtX3lMTupQGXe3UyDgvrOVRgkxpoCk=`. The sender's `user-agent` was
`Svix-Webhooks/1.83.0`.

Guard the JSON parse **after** the signature passes, the way the Daily handler does: a verified body
proves _origin_, not _shape_, and an uncaught `SyntaxError` becomes a 500, which tells the sender to
retry a body that can never parse.

### Response statuses

| Situation                                  | Answer                                      | Why                                                                        |
| ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------- |
| Verified, enqueued                         | `200` immediately                           | Ack fast; a `200` stopped retries on every observed delivery **[live]**    |
| Verified, already-seen `svix-id`           | `200`                                       | Idempotent replay                                                          |
| Missing/invalid signature, stale timestamp | `400`, body `{"error":"invalid signature"}` | Never name the reason on the wire — log it as a field                      |
| Raw body missing (misconfigured plugin)    | `400`                                       | Same literal — do not teach a caller how to iterate                        |
| Subscription row not found for the path    | `404`                                       | Nothing to verify against; the URL names no known subscription             |
| Secret cannot be decrypted / key unset     | `503`                                       | An **outage**, not a bad request — keep the delivery in the sender's queue |
| Redis down, enqueue failed                 | `503`                                       | Same reasoning                                                             |

⚠ **SKILL.md's webhook snippet comments "→ 400, no retry", and its own next paragraph says Svix
retries failed deliveries with exponential backoff and disables an endpoint after ~5 days [docs].
Those cannot both be true.** What the captures establish is only the success side: a `200` was never
retried **[live]**. Nothing was observed about how Svix treats a `4xx`. Design for the conservative
reading — **assume any non-2xx is retried** — which is why the table above splits "permanently
wrong" (`400`/`404`, cheap to re-reject) from "temporarily unable" (`503`, must be retried). Do not
answer `200` to a body you did not process, and do not answer `4xx` to a condition a retry would
fix.

### Idempotency

**Dedupe on `svix-id`.** Every delivery carried a distinct one **[live]**, so it is a usable
idempotency key. The house marker-table pattern is `daily_webhook_events` (see
`apps/api/src/routes/daily/webhook.ts`): insert-on-receipt inside the effect transaction,
`markProcessed` after, and — the subtle part — **branch on `processedAt`, not on row presence**, so
a delivery that died before committing its effect is repaired by the retry rather than skipped.

⚠ For _this_ handler the marker is optional today, and it is worth knowing why rather than
cargo-culting it. The only effect is `enqueueAvailabilityCacheRebuild`, whose BullMQ `jobId` is a
fixed `availability-${expertProfileId}` — a duplicate delivery collapses into the pending job by
construction. **The moment the handler grows a second, non-idempotent effect** (a counter, a
notification, an audit row), the marker table becomes mandatory. Decide that explicitly in BAL-468;
do not let it be decided by accident.

## A4 · What a ping does — and does not — mean

**It means: "something on this calendar changed. Recompute."** Nothing more.

- **No event id.** You cannot know what changed, and no follow-up read can tell you cheaply.
- **No delta read, ever, on any provider.** SKILL.md Constraint 3 / BAL-447. The ruling is shipped as
  data in `apps/api/src/services/calendar/sync-capability.ts` (inert by design — read it, do not
  import it) and enforced by `apps/api/src/invariants/sync-token-parity.test.ts`, which fails the
  build if any file outside those two names `syncToken` in code.
- **Deliveries coalesce.** 8 calendar changes produced **5** deliveries **[live]**: one isolated
  create → 1 delivery; 3 rapid creates → 2; 4 rapid deletes → 2, batched in roughly 10-second
  windows. One ping ≠ one change, in either direction.
- **`calendar.event.changed` is the only type ever observed.** The vendor documents
  `calendar.event.unknown` and `enduseraccount.created` / `updated` / `deleted` /
  `credential.updated` **[docs]** — and `credential.updated` demonstrably **does not fire on
  revocation**: 0 deliveries across 5.5 minutes spanning both a revoke and the `ACTIVE → EXPIRED`
  flip, with a live `event` subscription in place **[live]**. Handle an unknown `eventType` by
  logging and acking; never switch on it as though the set were closed.

### The enqueue

```typescript
// apps/api/src/jobs/availability-cache.ts — SHIPPED (today's caller is the Cronofy webhook)
export async function enqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const queue = getQueue(AVAILABILITY_CACHE_QUEUE); // 'rebuild-availability-cache'
    await queue.add(
      'rebuild-availability-cache',
      { expertProfileId },
      {
        jobId: `availability-${expertProfileId}`, // ← the coalescing key
        removeOnComplete: true,
        removeOnFail: true, // ← self-heal; see below
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }
    );
  } catch (err: unknown) {
    /* best-effort: a Redis hiccup must never fail the caller's mutation */
  }
}
```

Three properties to preserve when BAL-468 calls this from the Apiroc route:

1. **`jobId` is per EXPERT, not per calendar or per subscription.** The rebuild recomputes the whole
   forward window for the expert across every connection, so a per-calendar key would queue N
   redundant jobs for one expert whose two calendars both changed.
2. **`removeOnFail: true` is deliberate and load-bearing.** With a fixed `jobId`, a _retained_ failed
   job blocks every later enqueue for that expert — webhook, schedule save, override change,
   staleness cron — permanently wedging their availability. The worker's `failed` listener is the
   failure signal instead; it reaches Axiom and Sentry.
3. **The enqueue swallows its own errors.** So the webhook route must not treat "enqueued" as proven.
   If the route needs to answer `503` on a queue outage (per the table above), it has to check
   Redis itself rather than rely on this helper throwing.

⚠ **The route holds an `endUserAccountId` (or a subscription row); the job wants an
`expertProfileId`.** Resolve through the subscription row's `connection_id`, or via
`findConnectionsByEndUserAccountId` — which **returns an array**, deliberately. Fan out over every
live connection it returns; do not take `[0]`.

## A5 · The 7-day expiry and renewal

| Fact                                                             | Value **[live]**                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Create response fields                                           | **only** `webhookSubscriptionId`, `endpointSecret`           |
| `expiration` on the create response                              | **the key is not in the body at all**                        |
| `expiration` in the stored record (`calendarSubscriptions.list`) | `2026-08-21T08:35:11.000Z` for a `08:35:12` create           |
| Implied TTL                                                      | **exactly 7 days**                                           |
| Provider channel refs on the read model                          | `subscriptionId` (uuid) + `resourceId` — Google `watch` refs |
| `endpointSecret`                                                 | opaque string, 38 chars observed                             |

**The trap, precisely.** `CreateCalendarSubscriptionResponse` declares only two fields **[stat]**,
and the captured body contains only those two keys. A caller reading `response.expiration` gets
`undefined` and concludes subscriptions are permanent — which is almost certainly how the original
"they don't expire" claim arose. Read `expiration` from `calendarSubscriptions.list`, always.

> ⚠ SKILL.md's lifecycle table says `expiration` on the create response is "absent from the type;
> `null` in practice". The **key is absent from the body**, not present-and-null — the `null` in the
> spike's log line came from the harness printing `b.expiration ?? null`. It matters: `=== null` is
> a check that never fires.

**Whether Apiroc auto-renews before that expiry is UNCONFIRMED** and cannot be settled without a
7-day observation. The vendor question is BAL-455; the sweep is BAL-468 §3. Treat renewal as
caller-managed until told otherwise — the failure mode is silent and platform-wide (every expert's
change-push dies a week after connecting, with no error raised anywhere), so the asymmetry favours
building it.

### ⚠ There is no renew method

`CalendarSubscriptions` exposes exactly `list`, `create`, and `delete` **[stat]**. "Renewal" is
therefore **create-then-delete**, in that order:

1. `create` a fresh subscription for the same `(account, calendar)` with a fresh `webhookUrl`
   (the URL keys on the new row id, so it must be new).
2. Persist the new row — id, secret, and the `expiration` re-read from `list`.
3. `delete` the old subscription and **verify** it is gone (see [A6](#a6--delete-puts-the-id-in-the-body)).

Create-first leaves no gap in coverage. The cost is a short window where both subscriptions deliver,
which is harmless here for one specific reason: the rebuild is coalesced on
`availability-${expertProfileId}`, so duplicate pings collapse into one job. Do not reverse the
order to avoid the duplicates — a delete-first renewal has a real blind window, and a delete that
succeeds followed by a create that fails leaves the expert with no change-push at all.

### The monitor to add regardless of the vendor's answer

A daily job is cheap and catches the bad case either way:

```typescript
// Intended shape — BAL-468 §3. Runs whether or not the renewal sweep exists.
const soon = await calendarSubscriptionRepository.findExpiringBefore(addHours(new Date(), 48));
if (soon.length > 0) {
  log.warn(
    { count: soon.length, subscriptionIds: soon.map((s) => s.id) },
    'calendar subscriptions expiring inside 48h'
  );
}
```

- Alert on **count > 0**, not on a threshold. If renewal works, the steady state is zero.
- **Re-read `expiration` from `calendarSubscriptions.list` on every sweep**, never trust the stored
  copy alone — if Apiroc _does_ auto-renew, the vendor's record moves and ours does not, and a
  monitor reading only our column would alert forever.
- Also alert on the inverse: a live `calendar_connections` row with **zero** live subscriptions.
  That is the shape a silent expiry leaves behind, and no per-subscription check can see it.

## A6 · Delete puts the id in the BODY

**[stat + live]** The SDK issues:

```
DELETE /api/v1/calendarSubscriptions/{endUserAccountId}
Body: { "data": { "subscriptionId": "cmssoyzws1qs2oi2k08up0zjo" } }
```

The obvious path-style guess — `DELETE /calendarSubscriptions/{acct}/{id}`, which the spike tried
first — returns **404 and leaves the record intact** **[live]**. DELETE-with-a-body is unusual
enough that some proxies and HTTP clients drop it silently. **Go through
`apiroc.calendarSubscriptions.delete(endUserAccountId, subscriptionId)`; never hand-roll the
request.** The typed return is `{ success: boolean }` **[stat]**.

### ⚠⚠ Delete is forbidden while the credential is EXPIRED — which inverts the obvious ordering

**[live]** With the account in `EXPIRED`, deleting its subscriptions fails:

```
delete cmssoyzws… → AuthorizationError 403 "End user account credential expired"
delete cmssmvjh… → AuthorizationError 403 "End user account credential expired"
```

The credential is expired precisely _because_ the expert revoked, which is the reason you are
reconnecting — so at cleanup time the delete is already forbidden. **The correct order is
reconnect → delete stale → re-create**, never delete-then-recreate (SKILL.md Constraint 11).

It works because `endUserAccountId` is **stable across a revoke/reconnect cycle** **[live]**: the
same id came back, `createdAt` unchanged and `updatedAt` moved — reconnect is an UPDATE, not an
INSERT, so the old subscription records are still addressable afterwards.

⚠ **Cleanup must be verified, not best-effort.** A stale subscription keeps delivering for up to 7
days. Combined with per-calendar subscriptions and the 7-day clock, skipped cleanup accumulates:
verify by re-reading `calendarSubscriptions.list` after the deletes and reconciling against Balo's
rows, and alert on any vendor-side subscription Balo has no row for (BAL-468 §4). Whether
subscriptions survive a revoke → reconnect cycle at all is **untested** — SKILL.md's "Still
unverified" table names it, and the reconcile-by-list step above is what makes the answer not
matter.

## A7 · Inbound checklist

- [ ] Subscription is `subscriptionType: 'event'` with an explicit `calendarId`. Never `'calendar'`.
- [ ] One subscription row per subscribed calendar, per connection. `N` per expert is expected.
- [ ] `webhookUrl` is HTTPS and encodes **Balo's** subscription row id — no vendor ids in the path.
- [ ] `endpoint_secret` encrypted with `encryptCalendarToken`; never logged, never in analytics.
- [ ] `expiration` read from `calendarSubscriptions.list`, never from the create response.
- [ ] `fastify-raw-body` registered scoped: `global: false`, `encoding: false`, `runFirst: true`,
      route in the `routes` array — **and re-registered in the route's test file**.
- [ ] Handler order: load secret by path → `svix` verify raw bytes → parse JSON (guarded) → act.
      Nothing before verification writes, enqueues, or tracks.
- [ ] `svix-id` recorded; replay path is idempotent (or the enqueue is provably the only effect).
- [ ] `200` only after the delivery is accepted; `400` for permanently-bad; `503` for our outages.
      The wire body names no reason; the log line does.
- [ ] Enqueue is `enqueueAvailabilityCacheRebuild(expertProfileId, log)` with the per-expert `jobId`.
      No delta read, no `syncToken`, no `events.list` on this path.
- [ ] `endUserAccountId` → connections resolved as an **array**; fan out.
- [ ] Unknown `eventType` logs and acks.
- [ ] Renewal is create → persist → delete-and-verify. 48h expiry monitor exists either way.
- [ ] Reconnect path is reconnect → delete → re-create, and the delete failure mode (403 on an
      expired credential) is handled rather than assumed away.

---

# Part B — Outbound: writing consultation events

## B1 · Creating a consultation event

The real request, verbatim from `captures/phase1/google/04b-create.json` **[live]** (the Microsoft
request body is identical apart from the target calendar):

```json
{
  "title": "BAL-393 spike — ignore",
  "description": "Created by the BAL-393 throwaway harness. Safe to delete.\nhttps://balo.daily.co/spike-test-1",
  "start": { "dateTime": "2026-08-20T10:00:00Z", "timeZone": "UTC" },
  "end": { "dateTime": "2026-08-20T10:30:00Z", "timeZone": "UTC" },
  "transparency": "opaque",
  "privateExtendedProperties": { "baloBookingId": "spike-test-1" }
}
```

```typescript
// Intended shape — BAL-396.
const created = await callApiroc('events.create', () =>
  getApirocClient().events.create(connection.endUserAccountId, connection.targetCalendarId, {
    title,
    description, // ← the Daily join URL lives HERE
    start: { dateTime: startsAt.toISOString(), timeZone: 'UTC' },
    end: { dateTime: endsAt.toISOString(), timeZone: 'UTC' },
    transparency: 'opaque', // ← blocks time; without it the slot stays bookable
    privateExtendedProperties: { baloBookingId },
  })
);
await consultationRepository.setCalendarEventId(consultationId, created.id); // ← VENDOR-RETURNED
```

| Decision        | Rule                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target calendar | `calendar_connections.target_calendar_id` (per connection), defaulting to the `isPrimary` calendar on first connect. **Balo creates no calendars.** |
| `transparency`  | Always `'opaque'`. `'transparent'` means "free" — the event would exist but not block the slot                                                      |
| Tag             | `privateExtendedProperties.baloBookingId`. `Record<string,string>` **[stat]** — values must be strings                                              |
| Daily join URL  | In `description` (and/or `location`). Balo mints its own room, so vendor meeting-URL generation is unused                                           |
| Timezone        | Send UTC and let Balo's own tz layer render. Microsoft calendars expose **no** `timeZone` field at all **[live]**                                   |
| Store           | The **vendor-returned** `id`, on Balo's consultation record                                                                                         |

**Why no vendor meeting-URL generation.** `CreateEventInput.generateMeetingUrlProvider` exists
**[stat]**, and Balo does not use it: rooms come from Daily (see the `daily-co` skill), the join URL
is Balo's to control, and the capability is not portable anyway — Google calendars report
`allowedOnlineMeetingProviders: ["hangoutsMeet"]` while Microsoft reports `[]`, i.e. **no Teams link
generation through this API** **[live]**.

### ⚠ The create response is not a mirror of your request — never verify a write by reading its echo

Three captured divergences, all on a `200`:

| You sent                                           | Google returned **[live]**                      | Microsoft returned **[live]**                |
| -------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `start.dateTime: "2026-08-20T10:00:00Z"`, tz `UTC` | `"2026-08-20T20:00:00+10:00"`, tz still `"UTC"` | `"2026-08-20T10:00:00.000Z"`, tz `"Etc/UTC"` |
| `transparency: "opaque"`                           | **field absent from the response**              | `"opaque"`                                   |
| `description` containing `\n`                      | `\n` preserved                                  | **newline flattened to a space**             |

Parse instants; never string-compare a `dateTime`, a timezone label, or a description. The one field
whose echo you _must_ read is `id` — see B2.

## B2 · ⚠⚠ Caller-supplied ids are not a portable idempotency lever

`CreateEventInput.id` is optional **[stat]** and looks like a free idempotency key: derive it from
the consultation id and a retry becomes a harmless no-op. **It is not, and the two providers fail in
two different ways.**

**Microsoft: HTTP 200, id silently substituted.** From
`captures/phase1/microsoft/04a-create-custom-id.json` **[live]** — request carried
`"id": "bal393spikecustomid001"`; the `200` response carried
`"id": "AQMkADAwATM3ZmYBLWI3MmMtNWU3OS0wMAItMDAK…"`, a Graph id. Not a rejection. Not an error. **A
success response that quietly did something else.** A rejection would fail loudly in CI; this fails
silently, in production only, for Microsoft-based experts only — an idempotent-create-by-derived-id
design looks correct in every Google test and then **double-books on every retry**. (The spike's own
harness had exactly this bug: it judged the probe on `status < 400` and reported a false pass.)

**Google: HTTP 409 on the second write.** Google _does_ honour the id — which is why re-running the
probe against an id created by an earlier run returned **[live]**:

```json
{
  "error": 409,
  "message": "The requested identifier already exists.",
  "requestId": "5ac4b68ac87cae416448e1ed822fd85c"
}
```

That is a genuinely useful data point beyond idempotency: it is the **first captured 409 wire
shape**, and it is Envelope A with a **numeric** `error` — the same `A′` variant as an unknown
calendar. SKILL.md's "Still unverified" table lists 409 shapes as "assumed Envelope A, unverified";
this capture confirms the assumption. Follow it through the shipped boundary
(`apps/api/src/lib/apiroc/errors.ts`): 409 is not 400 and not 5xx, so
`classifyApiRequestErrorStatus` maps it to `kind: 'unknown'` — and `classifyRetry('unknown')`
returns **never retry, fail closed**. So on Google a derived-id retry surfaces as an un-retryable
`unknown` failure, and on Microsoft it surfaces as a duplicate event. One design, two wrong answers.

### The correct idempotency design

1. **Key idempotency off Balo's own record.** Before creating, read the consultation's stored
   `calendar_event_id`. Non-null ⇒ the event exists; do not create.
2. **Store the vendor-returned id** immediately after the create, in the same transaction as the
   state change that depends on it.
3. **Never send `id`.** Let the vendor generate it.
4. **If a derived id is ever genuinely required**, assert the returned id equals the requested one
   and treat a mismatch as an error:

   ```typescript
   const created = await callApiroc('events.create', () => client.events.create(acct, cal, input));
   if (input.id !== undefined && created.id !== input.id) {
     throw new Error(`Apiroc substituted the event id (sent ${input.id}, got ${created.id})`);
   }
   ```

5. **The crash-between-create-and-store window is real** and no vendor id closes it. If the create
   succeeds and the write of `calendar_event_id` fails, a retry would double-book. Recover the same
   way you reconcile — **query by tag** (B4) before creating, or sweep for orphans afterwards. That
   is what the `baloBookingId` tag is _for_; it is the durable link that survives a lost response.

## B3 · Updating and deleting

**Update** is `events.update(endUserAccountId, calendarId, eventId, data)`, a `PUT`, with
`UpdateEventInput = Partial<Omit<CreateEventInput, 'id' | 'generateMeetingUrlProvider'>>` **[stat]**
— a partial, so send only the fields that changed.

The tag survives a reschedule. On Google that is directly observed:
`"privatePropsSurvivePut": {"baloBookingId": "spike-test-1"}` **[live]**. On Microsoft the PUT
response returned `privateExtendedProperties: {}` — which is _not_ evidence of loss, because the
same event was still matched by a `metadataFilters` query. Never re-send the tag "just in case" on
an update; a partial `PUT` that omits it leaves it alone, and one that includes it is a no-op at
best.

**Delete** is `events.delete(endUserAccountId, calendarId, eventId)` → `200 {"success": true}`
**[live]** on both providers. Delete by the **stored vendor id**.

⚠ **Treat a `404` on delete as converged, not as a failure.** The expert may have deleted the event
by hand; the desired end state ("no consultation event on that calendar") already holds. The shipped
`classifyRetry` agrees — `not_found` → never retry. Clear Balo's stored `calendar_event_id` and move
on. A `403` is different: that is the expired-credential condition (SKILL.md's
[Credential expiry & reconnect detection](../SKILL.md)), and it means reconnect, not retry.

## B4 · Reconciliation by `metadataFilters`

**Querying the tag works on both providers. Reading the tag off a fetched event does not — and the
capture and SKILL.md disagree about exactly where.**

The query, verbatim **[live]** — `metadataFilters` is `Record<string,string>` **[stat]**, serialised
as a JSON object into the query string:

```
GET /api/v1/events/{acct}/{cal}?metadataFilters=%7B%22baloBookingId%22%3A%22spike-test-1%22%7D
```

Verified with a negative control, which matters — a filter that was silently ignored would also
"match 1 of 1" **[live]**:

| Query                                          | Result                        |
| ---------------------------------------------- | ----------------------------- |
| `metadataFilters={"baloBookingId":"tag-AAA"}`  | exactly the `tag-AAA` event ✔ |
| `metadataFilters={"baloBookingId":"tag-BBB"}`  | exactly the `tag-BBB` event ✔ |
| `metadataFilters={"baloBookingId":"tag-NOPE"}` | `[]` ✔ — the filter is real   |

**What the write responses do with the tag:**

| Response                             | Google **[live]**                  | Microsoft **[live]**                                                             |
| ------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------- |
| `events.create`                      | `{"baloBookingId":"spike-test-1"}` | `{}` — and `publicExtendedProperties` is `{}` too, so it is not merely relocated |
| `events.update` (PUT)                | `{"baloBookingId":"spike-test-1"}` | `{}`                                                                             |
| `events.list` with `metadataFilters` | `{"baloBookingId":"spike-test-1"}` | `{"baloBookingId":"spike-test-1"}`                                               |

> ⚠ **SKILL.md §M3 says the Microsoft tag is "never echoed back on a read". The captured filtered
> read echoes it** (`captures/phase1/microsoft/05-metadata-filter.json`). What is definitively `{}`
> on Microsoft is the **create** and **update** response. The design rule is unchanged and safe under
> either reading: **verify by querying, never by reading a tag off a write response.** But do not
> write a mapper that special-cases Microsoft into "the tag is always absent" — that is not what the
> capture shows.

### Paginate to exhaustion. Always.

```typescript
// Intended shape — BAL-396 §5 / BAL-468 §2. One `callApiroc` per page (never Promise.all).
async function findTaggedEvents(acct: string, cal: string, baloBookingId: string) {
  const found: Event[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await callApiroc('events.list', () =>
      getApirocClient().events.list(acct, cal, {
        metadataFilters: { baloBookingId },
        pageSize: PAGE_SIZE,
        pageToken,
      })
    );
    found.push(...res.data); // Microsoft's trailing page has data: [] — harmless, still terminates
    if (res.nextPageToken === undefined) break; // ← the ONLY termination condition
    pageToken = res.nextPageToken;
  }
  return found;
}
```

| Rule                                                   | Why                                                                                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow `nextPageToken` until it is absent              | Apiroc's own reference app reads only page 1. Do not copy it (SKILL.md Constraint 9)                                                                                                                     |
| ⚠ **Default page size is 400**                         | Any calendar under 400 events returns everything on page 1 — the bug is **invisible in dev and on test accounts** and only appears on a busy expert's real calendar. Test with a forced small `pageSize` |
| Microsoft emits a **trailing empty page** (`count: 0`) | One extra round-trip to terminate **[live]**. Terminate on the token, not on `data.length === 0`                                                                                                         |
| Do **not** read `nextSyncToken`                        | Constraint 3 — Balo stores no delta cursor. `sync-token-parity.test.ts` fails the build if you name it                                                                                                   |
| One `callApiroc` per page                              | `callApiroc`'s contract is exactly one fallible SDK call; a fan-out lands multiple captures in the sink and the request-id evidence is dropped                                                           |
| Cap the loop                                           | An unbounded `while (token)` against an unmeasured vendor rate limit is an outage waiting to happen                                                                                                      |

⚠ `events.list` is sanctioned **only** for reconciling Balo's own tagged consultation events.
Availability comes from `freeBusy.get` — busy slots, no titles, privacy by design (Constraint 4).
Reading a vendor capability as permission is exactly the mistake BAL-447 closed.

## B5 · Outbound checklist

- [ ] Every SDK call goes through `callApiroc('<operation>', …)` — one fallible call per wrapper,
      never a `Promise.all` inside one.
- [ ] Write to `connection.target_calendar_id`; create no calendars.
- [ ] `transparency: 'opaque'` on every consultation event.
- [ ] `privateExtendedProperties.baloBookingId` set on create; string values only.
- [ ] Daily join URL in `description`/`location`; `generateMeetingUrlProvider` unused.
- [ ] `id` is **not** sent. If it ever is, the returned id is asserted equal and a mismatch throws.
- [ ] The **vendor-returned** `created.id` is persisted, in the same transaction as the state change
      that depends on it.
- [ ] Idempotency reads Balo's stored `calendar_event_id` first; the crash window is closed by a
      tag query or an orphan sweep, not by a derived id.
- [ ] No write is verified by string-comparing the response echo (`dateTime`, tz label, description,
      `transparency` — all diverge).
- [ ] Update is a partial `PUT` that does not re-send the tag.
- [ ] Delete uses the stored id; `404` is converged, `403` means reconnect.
- [ ] Reconciliation queries `metadataFilters`; nothing reads the tag off a create/update response.
- [ ] Every `events.list` loop paginates to exhaustion with a small forced `pageSize` in tests and a
      hard page cap in production.
- [ ] `x-request-id` is on the normalized `ApirocError` (BAL-467 boundary) and reaches the log line —
      it is the only thing vendor support can act on.

---

## Divergences found while writing this file

Recorded here so the next person does not re-derive them. Each is a place SKILL.md or the BAL-393
FINDINGS say one thing and the shipped code or the raw capture says another.

| Claim                                                                    | What is actually there                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKILL.md's inbound flow, in present tense                                | No Apiroc webhook route exists. `routes/calendar/webhook.ts` is Cronofy, does **no** signature verification, and reads identity from the body               |
| SKILL.md's `calendarSubscriptions` Drizzle block                         | Correctly labelled a target — but worth stating flatly: **the table does not exist**, and neither does the `svix` dependency                                |
| Lifecycle table: `expiration` "absent from the type; `null` in practice" | The **key is absent from the response body**. `=== null` never fires                                                                                        |
| §M3: Microsoft tag "never echoed back on a read"                         | The captured `metadataFilters` read **does** echo it; only `create` and `update` return `{}`                                                                |
| "Still unverified: 409 wire shapes"                                      | Captured — Google duplicate-id create returns `{"error": 409, "message": "The requested identifier already exists.", …}`, Envelope A with a numeric `error` |
| Webhook snippet: bad signature "→ 400, no retry"                         | Only a `200` was observed to stop retries. Nothing establishes how Svix treats a `4xx`; design for "any non-2xx is retried"                                 |
