# The Apiroc SDK adapter boundary — as built

This file is the **how** behind SKILL.md's "Error Handling" and "Own the boundary — BAL-467 §2"
sections. SKILL.md tells you _why_ the vendor SDK cannot be consumed directly (two incompatible
wire envelopes, five SDK defects, an unsilenceable console logger); this file tells you what
BAL-467 and BAL-396 actually shipped in `apps/api/src/lib/apiroc/` and exactly how to add a new
Apiroc call on top of it. Read it when you are about to write code that talks to Apiroc — BAL-396
(connect / free-busy / events / health probe, now shipped) or BAL-468 (webhooks / subscription
lifecycle, still to come). Everything below is **as-built against commit `70fdfe7`** (BAL-396,
which merged directly on top of BAL-467's `eb6d4b2` — the core adapter files below
(`client.ts`, `errors.ts`, `interceptor.ts`, `retry.ts`, `logging.ts`, `sdk-shape.test.ts`) are
byte-for-byte unchanged between the two commits; only `index.ts` (8 new export lines) and four
whole new files are BAL-396's) unless explicitly marked as a later ticket's job. Evidence tags
follow SKILL.md's convention (see "How to read this document"): **[live]** = observed against the
real API in the BAL-393 spike, **[stat]** = read out of the published SDK bundle, **[docs]** =
vendor docs only. Untagged prose is a Balo design rule or a statement about Balo's own shipped
code.

> ⚠ **The boundary now ships LIVE.** BAL-467 shipped it constructed, tested, and exported with no
> caller; BAL-396 is the first live caller, and by a wide margin. `callApiroc` / `getApirocClient`
> are now called from `services/calendar/apiroc-connection.ts` (connect/provision/disconnect),
> `services/calendar/credential-status.ts` (the reconnect-required flip), the free/busy read in
> `services/availability/vendor-busy.ts` the booking gate depends on,
> `services/consultation-events/` (event write/delete/reconcile), `jobs/calendar-health-probe.ts`,
> and `routes/calendar/auth.ts` (the OAuth connect flow, via the new `oauth.ts` — see §1). Cronofy
> is gone outright: there is no `services/cronofy/`, `lib/cronofy.ts`, or `withCronofyRetry`
> anywhere left in the tree (`find apps/api/src -iname '*cronofy*'` returns nothing); the only
> surviving trace repo-wide is the removal migration,
> `packages/db/drizzle/0069_bal396_cronofy_removal.sql`. §4's call site and §8's checklist are no
> longer hypothetical — read the real call sites they now point at.

---

## 1. Module map

Everything lives in `apps/api/src/lib/apiroc/`. Ten source files, eleven test files — the extra
test is the shape tripwire, which has no source module of its own. Six of the ten (`index.ts`,
`client.ts`, `errors.ts`, `interceptor.ts`, `retry.ts`, `logging.ts`) are BAL-467's, unchanged
since. Four (`oauth.ts`, `reconnect.ts`, `paginate.ts`, `provider-labels.ts`) are BAL-396's.

| File                 | Responsibility                                                                                                                              | Do you touch it to add a call?               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `index.ts`           | The public surface + `callApiroc(operation, fn)`, the one sanctioned call wrapper. Opens the `AsyncLocalStorage` capture sink.              | **No** — you import from it                  |
| `client.ts`          | Lazy `UnifiedCalendarApi` singleton, `initApirocBoundary`, `ApirocInitReport`                                                               | No                                           |
| `errors.ts`          | `ApirocError`, `ApirocConfigError`, `ApirocFailureKind`, `normalizeApirocError`                                                             | No                                           |
| `interceptor.ts`     | The documented private reach into axios; capture of `x-request-id`, sanitized route template, Envelope B Zod recovery                       | No                                           |
| `retry.ts`           | `classifyRetry` — pure, no BullMQ coupling                                                                                                  | No                                           |
| `logging.ts`         | `createLogger('apiroc')` + winston `Console` transport suppression                                                                          | No                                           |
| `oauth.ts`           | `toApirocProviderType`, `buildApirocAuthorizeUrl` — the lowercase→uppercase provider translation and the hosted-OAuth authorize URL builder | No — a Scan B exception, see below           |
| `reconnect.ts`       | `classifyCredentialFailure` — composes `ApirocError.kind` + `wireMessage` into a `CredentialVerdict` (§3.1)                                 | No — one caller (`credential-status.ts`)     |
| `paginate.ts`        | `paginateApiroc` — the shared "follow `nextPageToken` to exhaustion" loop, page-capped and cursor-progress-checked                          | No — you import it for a paginating endpoint |
| `provider-labels.ts` | `calendarProviderLabel` — the one Balo-facing provider display-label map, consumed by notification templates                                | No — a Scan B exception, see below           |
| `sdk-shape.test.ts`  | The tripwire that fails loudly on an SDK/bundler bump (§7)                                                                                  | Only on a vendor upgrade                     |

**The answer to "which file do I touch to add a new call" is: almost never one of them.** Adding
an Apiroc call is writing a _caller_ — in `services/calendar/`, `services/availability/`, `jobs/`,
or a route — that imports `callApiroc`, `getApirocClient`, and (for a paginating endpoint)
`paginateApiroc` from this directory. New files under `lib/apiroc/` are boundary machinery only,
and would also silently enter the recursive source scan in `sdk-shape.test.ts` (§7, confirmed
still `{ recursive: true }` over `lib/apiroc/**`) — that rule is unchanged and still the default.

⚠ **BAL-396 added three files here, and the rule bent for exactly two of them — deliberately,
not by drift.** `invariants/sync-token-parity.test.ts`'s Scan B (ADR-1021's 18 Aug 2026 amendment
§1) bans a provider literal (`'google'`, `'microsoft'`, a `provider ===`/`switch (provider` form)
EVERYWHERE under `apps/api/src` except exactly two directories: `lib/apiroc/` (this one — "the
SDK's uppercase `ProviderType`, and display labels it drives") and `routes/calendar/` (the connect
surface). `oauth.ts` and `provider-labels.ts` exist BECAUSE that vocabulary has to live somewhere,
and Scan B says it can only be here or in the connect surface — so they are the sanctioned
exception, not a violation of "feature logic never lives under `lib/apiroc/`". Each holds exactly
one translation and nothing else: `provider-labels.ts` is a pure 3-way string lookup,
`oauth.ts` a pure URL-builder plus a config guard (§8's checklist item 1's "provider-literal site"
note is this). Both are themselves scanned by Scan E (no event-content read) and by
`sdk-shape.test.ts` — the exemption is narrow, not a blanket pass.

`reconnect.ts` is a THIRD, different kind of exception, and does not touch provider literals at
all: `classifyCredentialFailure` is a second interpretive layer on top of `errors.ts`'s taxonomy
(§3.1) — reads `err.kind` and `err.wireMessage`, writes nothing, calls nothing. It stops at
producing a `CredentialVerdict`; the DB write, the availability-cache clear, and the notification
publish it triggers all live in `services/calendar/credential-status.ts`, OUTSIDE this directory
— that file is the sole caller. `paginate.ts` needs no exception at all: it is boundary machinery
proper, the same shape as `retry.ts` — a generic per-page `callApiroc` loop with no provider or
feature awareness.

The rule as it actually stands: **provider-literal translation and vendor-error interpretation may
live in `lib/apiroc/`; DB writes, cache invalidation, and notification publishing may not** — a
new file that does the latter still belongs in `services/`, `jobs/`, or a route, full stop.

---

## 2. The sanctioned entry point

### What `index.ts` exports

```typescript
export { getApirocClient, getApirocInitReport, type ApirocInitReport } from './client.js';
export {
  ApirocError,
  ApirocConfigError,
  normalizeApirocError,
  type ApirocErrorParams,
  type ApirocFailureKind,
} from './errors.js';
export { classifyRetry, type RetryDecision } from './retry.js';
export {
  toApirocProviderType,
  buildApirocAuthorizeUrl,
  type ApirocOAuthProvider,
  type BuildApirocAuthorizeUrlParams,
} from './oauth.js';
export { classifyCredentialFailure, type CredentialVerdict } from './reconnect.js';
export { paginateApiroc } from './paginate.js';
export type {
  ApirocZodIssue,
  ApirocCapture,
  ApirocCaptureSink,
  ApirocInterceptorPosition,
} from './interceptor.js';
export type { ApirocConsoleSuppressionTier } from './logging.js';

export async function callApiroc<T>(operation: string, fn: () => Promise<T>): Promise<T>;
```

The three new exports (`oauth.js`, `reconnect.js`, `paginate.js`) are BAL-396's — `index.ts` is the
only one of the six BAL-467 core files that changed on this branch (8 added lines, confirmed by
`git diff eb6d4b2 70fdfe7 -- lib/apiroc/index.ts`), and this is the whole diff.

**Deliberately NOT exported from `index.ts`** — reach for any of these and you are working
around the boundary rather than through it:

| Symbol                                      | Lives in         | Why it is not on the public surface                                  |
| ------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `installInterceptor`, `reachAxiosInstance`  | `interceptor.ts` | Wiring; only `client.ts` and the shape test drive them               |
| `captureApirocFailure`, `readApirocCapture` | `interceptor.ts` | Run by the interceptor / `normalizeApirocError`, never by a caller   |
| `runWithApirocCaptureSink`                  | `interceptor.ts` | `callApiroc`'s entry point only — a second opener breaks cardinality |
| `initApirocBoundary`                        | `client.ts`      | Called by `getApirocClient()`; exported for the shape test           |
| `__resetApirocClientForTests`               | `client.ts`      | Test-only singleton reset                                            |
| `log`, `suppressSdkConsoleLogging`          | `logging.ts`     | The adapter's own Pino child; callers use their own scoped logger    |

Note that `ApirocCaptureSink` is exported as a **type only** — there is no supported way for a
caller to construct or read one.

### Obtaining the client and making a call

```typescript
import { callApiroc, getApirocClient, ApirocError } from '../../lib/apiroc/index.js';

const api = getApirocClient(); // OUTSIDE the wrapper — see the footgun below
const calendars = await callApiroc('calendars.list', () => api.calendars.list(endUserAccountId));
```

`getApirocClient(): UnifiedCalendarApi` is a **lazy** singleton — merely importing the module
never constructs a client (`client.test.ts` pins that). The SDK constructor throws on a missing
API key, and a module-level `const` would crash the shared Fastify app builder and every route
test whenever `APIROC_API_KEY` is unset. First call constructs the client, installs the
interceptor, suppresses the SDK console transport, and logs `apiroc_boundary_initialised`:

```typescript
export function getApirocClient(): UnifiedCalendarApi {
  if (clientSingleton) return clientSingleton;
  const apiKey = process.env.APIROC_API_KEY;
  if (!apiKey) throw new ApirocConfigError('APIROC_API_KEY is not set');
  const api = new UnifiedCalendarApi({ apiKey });
  initReport = initApirocBoundary(api);
  clientSingleton = api;
  return api;
}
```

⚠ **Call `getApirocClient()` outside the `callApiroc` wrapper.** `ApirocConfigError` extends
`Error`, **not** `ApirocError`, and is not one of the six SDK classes `normalizeApirocError`
recognises — so
`callApiroc('x', () => getApirocClient().calendars.list(id))` converts a missing API key into
`ApirocError { kind: 'unknown', status: undefined }`, which `classifyRetry` then refuses to
retry with the reason `'unclassifiable failure'`. A platform misconfiguration deserves to
surface as itself.

⚠ **`fn` must wrap exactly ONE SDK call that can fail.** This is a documented contract, not a
style note — see §3.3 for the two shapes that break it and what the boundary does about each.
A fan-out is `Promise.all(conns.map((c) => callApiroc('freeBusy.get', () => api.freeBusy.get(...))))`,
never one `callApiroc` around the whole `Promise.all`.

**Environment.** All three variables BAL-467 anticipated now exist, shipped by BAL-396, in both
`apps/api/.env.example` and `turbo.json`'s `globalEnv` (confirmed present in both — a `globalEnv`
omission would silently change the turbo cache key rather than failing, so both were checked, not
just one): `APIROC_API_KEY` (read by `client.ts::getApirocClient`), and `APIROC_APP_ID` /
`APIROC_REDIRECT_URI` (read by `oauth.ts::buildApirocAuthorizeUrl`, §1 — absent either one throws
`ApirocConfigError`, never a silent `!`). `.env.example`'s inline comment on `APIROC_API_KEY` still
reads "the boundary is INERT in this ticket… no live caller yet" — that line is a BAL-467 leftover
and is now stale prose in a comment, not a statement to trust; see the top-of-file warning above
for the current, LIVE reality.

---

## 3. Error normalisation as built

### 3.1 The taxonomy

`ApirocFailureKind` is a closed union of eight values. **It is Balo's, not the SDK's** — the SDK
classes are an input, the kinds are the output.

| Thrown by the SDK                    | `kind`         | `status`    | Notes                                              |
| ------------------------------------ | -------------- | ----------- | -------------------------------------------------- |
| `RateLimitError`                     | `rate_limited` | `429`       | carries `retryAfterSeconds` (may be `undefined`)   |
| `NotFoundError`                      | `not_found`    | `404`       |                                                    |
| `AuthorizationError`                 | `forbidden`    | `403`       |                                                    |
| `AuthenticationError`                | `unauthorized` | `401`       | bad platform key **and** revoked expert credential |
| `APIRequestError` (status 400)       | `validation`   | `400`       | Envelope B — `zodIssues` recovered                 |
| `APIRequestError` (status 5xx)       | `server_error` | e.g. `500`  |                                                    |
| `APIRequestError` (409 / any other)  | `unknown`      | as reported | 409 is deliberately not its own kind               |
| `UnifiedCalendarApiError`            | `network`      | `undefined` | no HTTP response — timeout / DNS / socket          |
| anything else (string, plain object) | `unknown`      | best-effort | never throws; fails closed                         |

⚠ **`reconnect_required` is deliberately NOT an `ApirocFailureKind`, and still isn't** —
confirmed unchanged in `errors.ts` (byte-for-byte identical to the BAL-467 commit): the closed
union above is still exactly eight values, `reconnect_required` is not one of them, and
`normalizeApirocError` still classifies by HTTP status only. Distinguishing a revoked expert
credential from a bad platform API key — both arrive as 401 / `AuthenticationError` — needed
`wireMessage` composed with a credential-status vocabulary; **that composition is BAL-396's job,
and it now exists, one layer above this boundary, in `lib/apiroc/reconnect.ts`**:
`classifyCredentialFailure(err: ApirocError): CredentialVerdict` reads `err.kind` and
`err.wireMessage` and returns one of four verdicts — `reconnect_required`,
`platform_auth_failure`, `transient`, or `other` — see its file docblock for the exhaustive
discriminator table and why an ABSENT `wireMessage` resolves to `platform_auth_failure`, never
the expert's fault. It is exported
from `index.ts` alongside `callApiroc`, so a caller never has to reach past this boundary to use
it — but it stops at the verdict: the only caller, `services/calendar/credential-status.ts`'s
`applyCredentialFailure`, owns the side effects (flipping `credential_status`, clearing the
availability cache, publishing the `calendar.auth_error` notification, at most once per breakage).
This boundary's OWN contract is unchanged: `errors.ts` classifies by status and carries the raw
evidence untouched; `reconnect.ts` is the next slice composing on top of it, exactly as this
file's BAL-467-era text anticipated. Do not invent a THIRD reading of `wireMessage` outside
`reconnect.ts` — that file is now the one sanctioned place.

The thrown object:

```typescript
export class ApirocError extends Error {
  readonly kind: ApirocFailureKind;
  readonly operation: string; // the label you passed to callApiroc
  readonly status?: number;
  readonly requestId?: string; // the x-request-id header — for vendor escalation
  readonly retryAfterSeconds?: number;
  readonly zodIssues?: ReadonlyArray<ApirocZodIssue>;
  readonly wireMessage?: string;
  readonly wireErrorRaw?: unknown; // non-enumerable — see §3.5
}
// message === `Apiroc ${operation} failed (${kind})`; the SDK error is attached as `cause`.
```

### 3.2 The capture step — `x-request-id` and Envelope B

The SDK registers its own axios response interceptor in the `BaseClient` constructor, and it
**does not re-reject the axios error — it `throw`s a brand-new instance** whose constructor
accepts neither `config` nor `response` **[stat]**. A call wrapper alone therefore only ever
sees `"Request failed with status code 400"`. So `installInterceptor` reaches through two
documented-private hops (`UnifiedCalendarApi.baseClient` → `BaseClient.client`, `dist/index.d.ts`
lines 751 and 526 **[stat]**), registers via the public `.use()`, then **unshifts our handler to
index 0** so it runs before the SDK's mangling handler. Every hop is optional-chained; nothing
throws; a shape mismatch degrades to status-only branching and logs one warn.

Capture, faithfully reduced from `interceptor.ts::captureApirocFailure`:

```typescript
const status = err.response?.status;
const requestId = extractHeader(err.response?.headers, 'x-request-id');
const method = err.config?.method;
const url = sanitizeRouteTemplate(err.config?.url); // SANITIZED, never raw — see below
const wireErrorRaw = err.response?.data;
const wireMessage = extractWireMessage(wireErrorRaw, err.message);
const zodIssues = status === 400 ? parseZodIssues(wireErrorRaw) : undefined;

log.error(
  { status, requestId, method, url, zodIssuePaths: zodIssues?.map((i) => i.path), wireMessage },
  'apiroc_request_failed'
);
```

`extractHeader` reads the key as given, lower-cased, and upper-cased, and returns a value only
when it is a `string`. **`x-request-id` is on every response header including 200s [live]**; on
Envelope A it is duplicated into the body, on Envelope B the header is the only copy — which is
why the capture takes it from the header in both cases.

⚠ **The URL is sanitized, never raw.** The SDK embeds `endUserAccountId` _and_, on Google, the
`calendarId` — which **is the expert's email address [live]** — directly in the path
(`/api/v1/events/{endUserAccountId}/{calendarId}`). `sanitizeRouteTemplate` keeps the first
three segments (`api`, `v1`, `<resource>`), collapses the rest to a count, and — as defence in
depth against a future SDK path shape — redacts any _kept_ segment containing `@` or `%40`:

```
/api/v1/events/eua-abc123/expert.name%40gmail.com  →  /api/v1/events/[redacted:2]
/events/expert.name%40gmail.com                    →  /events/[redacted:email]
```

Envelope B recovery, from `parseZodIssues`. The wire body is
`{ success: false, error: { name: 'ZodError', message: <double-encoded JSON string> } }` — there
is **no top-level `message`**, which is precisely why the SDK's `data?.message || error.message`
falls through to axios's generic text:

```typescript
const message = (errorField as Record<string, unknown>).message;
if (typeof message !== 'string') return undefined;
try {
  const parsed: unknown = JSON.parse(message); // the double decode
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter(isObject).map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path ?? ''),
    code: typeof issue.code === 'string' ? issue.code : undefined,
    message: typeof issue.message === 'string' ? issue.message : undefined,
  }));
} catch {
  return undefined; // never throws inside an interceptor
}
```

→ `[{ path: 'calendarId', code: 'invalid_type', message: 'Required' }, …]`. Malformed JSON
degrades to `undefined`; it never throws.

### 3.3 How the evidence survives the SDK — the `AsyncLocalStorage` sink

The interceptor best-effort annotates the raw error and its `config` with a non-enumerable
`__apirocCapture__`, but for **every** status class the SDK recognises that annotation is
**guaranteed lost** — the SDK constructs a new error object that carries neither `config` nor
`response` **[stat]**. The load-bearing mechanism is therefore a side channel:

- `callApiroc` creates a sink `{ captures: [] }` and runs `fn` inside
  `captureContext.run(sink, fn)`.
- `captureApirocFailure` runs as a promise continuation of that same call, so
  `captureContext.getStore()` resolves to the same sink and pushes the capture into it.
- `callApiroc`'s `catch` reads `sink` **by closure reference**, not `getStore()` — the ALS
  context has already unwound by then.
- `AsyncLocalStorage` isolates concurrent `callApiroc` invocations by construction; a
  module-level variable would not.

The sink **accumulates** rather than holding one overwritable slot, and cardinality decides:

```typescript
const [capture] = sink.captures;
if (sink.captures.length > 1) {
  log.warn(
    { operation, count: sink.captures.length, requestIds: sink.captures.map((c) => c.requestId) },
    'apiroc_capture_ambiguous'
  );
  throw normalizeApirocError(err, operation, undefined); // attach NOTHING
}
throw normalizeApirocError(err, operation, capture);
```

Two contract-violating shapes, both measured in review and both pinned in `index.test.ts`:

| Shape                                                            | Captures | Behaviour                                                                                                                            |
| ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Fan-out — two concurrent calls fail inside one `callApiroc`      | 2        | **No** capture attached; `apiroc_capture_ambiguous` warns. Split into per-call wrappers                                              |
| `fn` swallows an Apiroc failure, then throws something unrelated | 1        | Indistinguishable by count — the swallowed evidence **still attaches**. This is why the contract is documented, not merely tolerated |

### 3.4 The `instanceof` ladder

All four subclasses extend `APIRequestError`, which extends `UnifiedCalendarApiError`
**[stat]**, so the ladder in `normalizeApirocError` is ordered **most-specific-first**:

```
RateLimitError → NotFoundError → AuthorizationError → AuthenticationError
  → APIRequestError → UnifiedCalendarApiError → unrecognised shape ('unknown')
```

The ordering has **teeth**, and the mechanism is worth understanding before you copy the pattern
elsewhere. `classifyApiRequestErrorStatus` maps only `400 → validation` and `5xx → server_error`;
401/403/404/429 fall through to `'unknown'` there **on purpose**. If someone reorders the ladder
so `APIRequestError` is checked first, a real 401 lands in that function and surfaces as
`'unknown'` — a visible test failure — instead of coincidentally still saying `'unauthorized'`
and hiding the regression.

⚠ **Never branch on `error.constructor.name`** — the bundler mangles it to
`_AuthenticationError`. This is enforced, not merely advised: `sdk-shape.test.ts` scans every
non-test `.ts` file under `lib/apiroc/` (recursively, with comments stripped) and fails on the
string `constructor.name`.

### 3.5 `wireErrorRaw` is non-enumerable, on purpose

Envelope B echoes rejected input — an `events.create` 400 can carry event titles and attendee
email addresses. Pino's default `err` serializer copies own **enumerable** properties via
`for…in`, so a plain assignment would have sent the whole raw body to Axiom on the first
CLAUDE.md-mandated `log.error({ err })`. The constructor therefore does:

```typescript
Object.defineProperty(this, 'wireErrorRaw', {
  value: params.wireErrorRaw,
  enumerable: false,
  configurable: true,
  writable: true,
});
```

It stays directly readable (`err.wireErrorRaw`) but is invisible to `for…in`, `Object.keys`, and
`JSON.stringify`. Behind that, BAL-467 also added the API app's first Pino `redact` config in
`packages/shared/src/logging/index.ts` — `REDACT_PATHS` covers `wireErrorRaw`, `err.wireErrorRaw`,
`*.wireErrorRaw` and, separately, `zodIssues` / `err.zodIssues` / `*.zodIssues` (a Zod
`invalid_enum_value` message echoes the received value verbatim). **The interceptor's own log
line only ever emits `zodIssuePaths`, never `.message` — keep that discipline in your call
sites.**

---

## 4. The branch table a caller writes

Given a thrown boundary error:

| You may branch on            | Because                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `err instanceof ApirocError` | `Object.setPrototypeOf` runs in the constructor; reliable across bundling     |
| `err.kind`                   | The one sanctioned control-flow signal. A closed union of eight values        |
| `err.status`                 | Observability, and for a status inside `kind: 'unknown'` (e.g. 409)           |
| `classifyRetry(err)`         | The single retry policy (§5) — do not re-derive it from `kind` by hand        |
| `err.retryAfterSeconds`      | Only via `classifyRetry`, which already handles the `undefined` and `0` cases |

| You must NEVER branch on | Because                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `err.constructor.name`   | Bundler-mangled to `_AuthenticationError`. Scanned for and failed in CI                                                                                                           |
| the SDK's `.code`        | Hardcoded constants restating the HTTP status for 401/403/404/429; `undefined` for everything else — it carries no information the status doesn't **[live + stat]**               |
| the SDK's `.details`     | Always `undefined` — there is no such wire field **[live]**                                                                                                                       |
| the wire `error` field   | Observed as `"Error"`, the number `404`, `"InvalidRefreshToken"`, `"InternalServerError"`, and a `ZodError` object **[live]** — a `string \| number \| object` union, not an enum |
| `err.wireErrorRaw`       | Log-only evidence, unknown and unparsed. Never compare it to a literal                                                                                                            |
| `err.wireMessage`        | Not directly. `classifyCredentialFailure` (`lib/apiroc/reconnect.ts`, §3.1) composes it into a reconnect signal — call THAT, don't re-read `wireMessage` yourself                 |

⚠ **The ordering hazard, restated for callers.** If you ever write a second normalizer, a
`catch` that checks a base class before its subclasses silently swallows the specific cases —
`AuthenticationError` _is_ an `instanceof APIRequestError`. The rule is most-specific-first, and
the reason `errors.ts` looks redundant (why check four subclasses when the base would match?) is
exactly this.

⚠ **`ApirocConfigError` is not an `ApirocError`.** A `catch (e) { if (e instanceof ApirocError) … }`
misses it entirely. Handle configuration failure separately, or let it propagate as a 500.

A real, shipped call site — `jobs/calendar-health-probe.ts`'s `probeAndHeal`, condensed (see the
file for the mass-failure breaker and the deferred-write batching that sit around this):

```typescript
await callApiroc('calendars.list', () =>
  getApirocClient().calendars.list(endUserAccountId, { pageSize: 1 })
);
// … success path: markCredentialChecked / re-provision / heal (see the file) …
```

```typescript
// catch site, elsewhere in the same file — the ApirocError is DEFERRED, not handled inline:
if (!(err instanceof ApirocError)) {
  /* not this boundary's error — rethrow/skip, see the file */
}
const verdict = classifyCredentialFailure(err); // lib/apiroc/reconnect.ts, §3.1
// … later, batched: await applyCredentialFailure(connection, err, 'health_probe');
```

`applyCredentialFailure` (`services/calendar/credential-status.ts`, §3.1) is where `err.kind`,
`err.operation`, `err.status`, and `err.requestId` actually get logged, and where the
`kind === 'unauthorized' || kind === 'forbidden'` branch this file's earlier revision left as a
TODO now really exists — reached through `classifyCredentialFailure`, never a hand-rolled check.
A minimal caller that only needs normalized-error logging (no reconnect handling) still looks like
the shape below:

```typescript
try {
  const calendars = await callApiroc('calendars.list', () => api.calendars.list(endUserAccountId));
  return calendars;
} catch (err: unknown) {
  if (err instanceof ApirocError) {
    log.error(
      {
        operation: err.operation,
        kind: err.kind,
        status: err.status,
        requestId: err.requestId,
        zodIssuePaths: err.zodIssues?.map((i) => i.path),
      },
      'calendar_list_failed'
    );
  }
  throw err;
}
```

---

## 5. Retry policy as built

The policy lives in **one place**, `retry.ts::classifyRetry` — pure, no I/O, no BullMQ coupling.
Confirmed still true on this branch: no caller anywhere under `apps/api/src` invokes
`classifyRetry` (`grep -rn classifyRetry` finds only its own definition, its own test, and the
`index.ts` re-export). **BAL-396 shipped without wiring this mapping** — none of its callers
(`calendar-health-probe.ts`, `apiroc-connection.ts`, `vendor-busy.ts`, `consultation-events/`) map
a `classifyRetry` decision onto BullMQ job options; that remains a future ticket's job.

```typescript
export type RetryDecision =
  | { readonly retry: false; readonly reason: string }
  | { readonly retry: true; readonly afterMs?: number; readonly reason: string };

export function classifyRetry(err: ApirocError): RetryDecision;
```

| `kind`         | Decision                                        | Why                                                              |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `validation`   | never                                           | permanent programming error                                      |
| `unauthorized` | never                                           | credential problem → reconnect (BAL-396 §2), not retry           |
| `forbidden`    | never                                           | retrying will not change the outcome                             |
| `not_found`    | never                                           | the resource does not exist                                      |
| `rate_limited` | **retry**, `afterMs = retryAfterSeconds * 1000` | falls back to `5000` when the header was absent — never `NaN`    |
| `server_error` | **retry**                                       | likely transient                                                 |
| `network`      | **retry**                                       | likely transient                                                 |
| `unknown`      | never — **fail closed**                         | unbounded retry amplification against an unmeasured vendor limit |

Two edge cases pinned by `retry.test.ts`: `retryAfterSeconds === 0` yields `afterMs: 0` (it must
not fall through the falsy check to the default), and an absent header yields a finite positive
number, never `NaN`. The `5000 ms` default is documented as a placeholder — **the sandbox
rate-limit magnitude is unmeasured** (SKILL.md "Rate limits"; the BAL-393 probe was never run),
so treat it as a floor, not a tuned value.

Note the asymmetry with the SKILL.md summary sentence: as built, `unknown` (which includes 409
and every unrecognised throw shape) also never retries, and the rate-limit arm has a default
backoff. There is no exponential backoff in this module — sizing attempts and growth is the job
of whatever BullMQ configuration consumes the decision.

---

## 6. Logging

The SDK builds a **module-level** winston logger with an unconditional `Console` transport and
logs every API error at level `error` **[stat]**. Winston's `error` is level 0, so **no
`LOG_LEVEL` value suppresses it**. Those lines bypass Pino, carry no `requestId` / `userId`,
never reach Axiom as structured logs, and pollute Railway stdout — a direct conflict with
CLAUDE.md's "never use `console.log` / `console.error` in application code". Worse, the same
logger emits request/response at `debug`, and `endUserAccounts.getCredentials()` returns raw
provider access/refresh tokens **[stat]** — an unredacted-secret-to-stdout path for anyone who
sets `LOG_LEVEL=debug`. **Suppression is a security requirement, not tidiness.**

As built, one tier, `logging.ts::attemptPrototypeSuppression`:

```typescript
const localRequire = createRequire(import.meta.url);
const sdkEntryPath = localRequire.resolve('@apiroc/unified-calendar-api-node-sdk');
const sdkRequire = createRequire(sdkEntryPath);          // rooted at the SDK's own package dir
const winstonModule = sdkRequire('winston') as { transports?: { Console?: { prototype?: … } } };
const consoleTransportPrototype = winstonModule.transports?.Console?.prototype;
if (!consoleTransportPrototype || typeof consoleTransportPrototype.log !== 'function') return false;
consoleTransportPrototype.log = function apirocSuppressedWinstonConsoleLog(_info, callback) {
  if (typeof callback === 'function') callback();
};
```

Three things make that safe and load-bearing:

1. **The `require` is rooted at the SDK's resolved entry path**, not at `apps/api`. Under pnpm's
   strict, non-hoisted `node_modules`, resolving `winston` from `apps/api` would either fail or
   reach a _different_ installed copy than the SDK's. Node shares one module-cache entry per
   resolved CJS file regardless of loader, so this reaches the SDK's exact winston instance.
2. **Balo declares no winston anywhere** — `logging.test.ts` walks every `package.json` in the
   repo and asserts it, and separately asserts the SDK _does_ declare it. Patching
   `Console.prototype.log` process-wide is only safe while that premise holds.
3. It **never throws** and returns a tier for `ApirocInitReport`: `'prototype'` on success,
   `'failed'` otherwise, with a single `apiroc_sdk_console_suppression_failed` warn through Pino.

Everything the adapter itself logs goes through `createLogger('apiroc')`. The full event
vocabulary — grep-able, and worth alerting on:

| Level   | Event                                   | Meaning                                                              |
| ------- | --------------------------------------- | -------------------------------------------------------------------- |
| `info`  | `apiroc_boundary_initialised`           | first `getApirocClient()`; carries the whole `ApirocInitReport`      |
| `error` | `apiroc_request_failed`                 | one per captured failure, with `requestId` and `zodIssuePaths`       |
| `warn`  | `apiroc_capture_ambiguous`              | a `callApiroc` contract violation — evidence deliberately dropped    |
| `warn`  | `apiroc_interceptor_reach_failed`       | the private reach failed; boundary degraded to status-only           |
| `warn`  | `apiroc_interceptor_order_degraded`     | our handler could not be moved to index 0 — captures will be mangled |
| `warn`  | `apiroc_sdk_console_suppression_failed` | the SDK is now writing unstructured lines to stdout                  |

The last three all mean _the boundary is running degraded but not broken_. `installInterceptor`
returns `interceptorInstalled: false` rather than throwing, and `normalizeApirocError` still
classifies by status — you lose `requestId` and Zod field paths, not correctness.

---

## 7. `sdk-shape.test.ts` is a tripwire, not a unit test

Its whole purpose is that **an SDK or bundler bump fails LOUDLY in CI rather than silently
degrading the private reach to status-only branching in production.** Pinned against SDK
**2.0.1**.

| What it pins                                                                                                                         | What a failure means                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Hop 1: `UnifiedCalendarApi.baseClient` is a reachable object (`dist/index.d.ts:751`)                                                 | The private field moved or was renamed — re-derive `reachAxiosInstance`                                                                     |
| Hop 2: `BaseClient.client` is reachable and axios-shaped (`dist/index.d.ts:526`)                                                     | Same, one level down                                                                                                                        |
| `interceptors.response.use` is a function                                                                                            | The SDK stopped using axios, or wraps it                                                                                                    |
| The SDK registers **≥1** response interceptor of its own before we touch it                                                          | If it stopped, the reorder-to-front dance is now unnecessary — **delete it**, don't "fix" the assertion                                     |
| After `initApirocBoundary`, `handlers[0].rejected` is **identity-equal** to the handler we registered                                | The reorder silently no-opped; captures would see only the SDK's mangled error                                                              |
| Negative controls: `installInterceptor({})` and `{ baseClient: { notClient: true } }` degrade without throwing, warning exactly once | The graceful-degradation path regressed                                                                                                     |
| Source scan of `lib/apiroc/**` (recursive, comments stripped): no `constructor.name`, no `syncToken`                                 | Someone reintroduced a mangled-name branch, or a delta cursor (Constraint 3)                                                                |
| Every request-path template literal in the installed `dist/index.js` starts with `/api/v1/`, and there is no other path shape        | `ROUTE_TEMPLATE_KEPT_SEGMENTS = 3` no longer guarantees the expert's email is collapsed — re-derive `sanitizeRouteTemplate` before shipping |

**When a vendor upgrade breaks it:** open the new `dist/index.d.ts` and `dist/index.js`,
re-verify the two private hops and the path shape by hand, then update the expectations
**deliberately, with the new line numbers written into the assertion messages**. Never delete an
assertion, never loosen a count to `toBeGreaterThanOrEqual(0)`, and never `skip` the file to get
a build green — the failure mode this guards is invisible in production (you get less error
detail, not an exception), which is exactly why the tripwire exists. `logging.test.ts`'s
"winston is not a direct Balo dependency" pair is the same kind of premise pin and deserves the
same treatment.

---

## 8. Adding a new Apiroc call — checklist

**Already done for you:** error normalisation, `x-request-id` capture, Envelope B Zod recovery,
PII-sanitized route templates, the non-enumerable `wireErrorRaw` plus Pino `redact` paths, the
winston console suppression, retry classification, and the SDK shape tripwire. You should not
re-implement any of it, and you should not need to open `interceptor.ts`.

1. **Check the call is sanctioned.** Read SKILL.md's "Key Constraints & Gotchas" — especially
   Constraint 3 (no delta key, ever), Constraint 4 (free/busy for availability; full event reads
   only for Balo's own tagged events via `metadataFilters`), and Constraint 9 (paginate to
   exhaustion). The vendor's method surface is not permission.
2. **Import from the boundary**, never from `@apiroc/unified-calendar-api-node-sdk` directly in
   feature code: `import { callApiroc, getApirocClient, ApirocError } from '../../lib/apiroc/index.js';`
   (note the `.js` extension — `apps/api` convention).
3. **Resolve the client outside the wrapper**: `const api = getApirocClient();` so an
   `ApirocConfigError` stays a config error (§2).
4. **Wrap exactly one SDK call** per `callApiroc`, with a short stable `operation` label matching
   the SDK method (`'calendars.list'`, `'freeBusy.get'`, `'events.create'`). It is used in logs
   and in the error message; it is never read off the wire.
5. **Fan out per call, not per batch** — `Promise.all(items.map((i) => callApiroc(…)))`. One
   wrapper around a `Promise.all` drops all evidence and logs `apiroc_capture_ambiguous`.
6. **Paginate to exhaustion** where the endpoint paginates, each page its own `callApiroc`.
   Default page size is 400 **[live]**, so the bug is invisible on test accounts; Microsoft emits
   a trailing empty page the loop must terminate on cleanly.
7. **Branch on `kind` only** (§4). Log through your module's `createLogger(...)` child with
   `operation`, `kind`, `status`, `requestId`, and — if you log Zod detail at all — issue
   **paths** only. Never `console.*`.
8. **Route retries through `classifyRetry`**, mapping `retry` / `afterMs` onto BullMQ job
   options. Do not write a second policy table.
9. **Never write `syncToken`** anywhere under `apps/api/src` — Scan A of
   `apps/api/src/invariants/sync-token-parity.test.ts` covers the whole tree (only
   `services/calendar/sync-capability.ts` and `invariants/` are exempt), and `sdk-shape.test.ts`
   independently scans `lib/apiroc/**`. Scans B (no provider literal) and E (no event-content
   read) are now **tree-wide over all of `apps/api/src`** as of ADR-1021's 18 Aug 2026 (BAL-396)
   amendment §1/§2 — not scoped to `jobs/`, `services/availability/`, `services/calendar/`, or
   `routes/calendar/` as an earlier revision of this checklist said. Scan B exempts exactly
   `lib/apiroc/` and `routes/calendar/`; Scan E exempts exactly `services/consultation-events/`.
   Your new file is covered by whichever of the two it does NOT fall inside (the two exemption
   sets are disjoint and jointly exhaustive — `sync-token-parity.test.ts`'s own Scan E6 asserts
   this).
10. **Put feature logic outside `lib/apiroc/`**, with two narrow, named exceptions (§1): a
    provider-literal translation (Scan B's exemption — `oauth.ts`'s uppercase `ProviderType`,
    `provider-labels.ts`'s display labels) or a pure interpretive layer over `ApirocError`
    (`reconnect.ts`'s `classifyCredentialFailure`, which writes and calls nothing). Anything that
    touches the DB, the availability cache, or a notification — even calendar-connection logic —
    still belongs in `services/`, `jobs/`, or a route. A file that doesn't fit either exception
    also enters the recursive source scan in `sdk-shape.test.ts` and reads as boundary machinery
    to the next person.
11. **New env vars go in two places** — `apps/api/.env.example` **and** `turbo.json`'s
    `globalEnv` (that is how `APIROC_API_KEY` shipped).
12. **Test it.** Unit-test the caller with the SDK method mocked; assert the `ApirocError.kind`
    your branches depend on. If you add a repository file, CLAUDE.md requires a matching
    `*.integration.test.ts` in the same PR.

---

## 9. Divergences between SKILL.md and the shipped code

SKILL.md was written before BAL-467 merged; a few of its forward-looking statements are now
stale. Where they conflict, **the shipped code wins** and is described above.

| SKILL.md says                                                                                                                                       | The shipped code does                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "SDK Initialisation" shows `apps/api/src/lib/apiroc.ts` with a module-level `export const apiroc = new UnifiedCalendarApi({...})`                   | A directory `apps/api/src/lib/apiroc/` with a **lazy** `getApirocClient()`. A module-level const would crash the shared Fastify app builder and every route test when `APIROC_API_KEY` is unset                                                                                 |
| "Environment variables required: `APIROC_API_KEY`, `APIROC_APP_ID`, `APIROC_REDIRECT_URI`"                                                          | Was true only of BAL-467 (only `APIROC_API_KEY` existed then). BAL-396 shipped the other two — all three now present in both `.env.example` and `turbo.json` `globalEnv`; this divergence is CLOSED                                                                             |
| Earlier revisions of "Where the rules live" listed the SDK adapter boundary as pending on BAL-467 and said no `references/*.md` files existed       | BAL-467 merged as `eb6d4b2`. SKILL.md's table was reconciled alongside this file, which is the reference it now points at                                                                                                                                                       |
| "Own the boundary — BAL-467 §2" is written as work to do; defects 1 and 3 (400 payload discarded, `requestId` dropped) are described as unmitigated | Both are mitigated as built — `requestId` and the recovered Zod issue array reach the thrown `ApirocError`, pinned end-to-end in `interceptor.test.ts`                                                                                                                          |
| The SDK normalisation table is presented as the taxonomy                                                                                            | That is the **SDK's** taxonomy. Balo's is eight `ApirocFailureKind` values; 409 maps to `unknown`. `reconnect_required` is still deliberately not one of the eight, but the composition BAL-396 §2 owed now ships — `lib/apiroc/reconnect.ts::classifyCredentialFailure` (§3.1) |
| "Retry policy: 400 never · 401/403 never · 404 never · 429 back off by `retryAfter` · 5xx and network yes"                                          | Same, plus two as-built refinements: a documented `5000 ms` default when `Retry-After` is absent, and `unknown` **fails closed**                                                                                                                                                |
| "The boundary must patch or replace that transport"                                                                                                 | One tier, as built: override `winston.transports.Console.prototype.log`, via a `require` rooted at the SDK's own resolved path. Safe only because no Balo package declares winston — a premise `logging.test.ts` pins                                                           |
