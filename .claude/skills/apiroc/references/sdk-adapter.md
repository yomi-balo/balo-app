# The Apiroc SDK adapter boundary — as built

This file is the **how** behind SKILL.md's "Error Handling" and "Own the boundary — BAL-467 §2"
sections. SKILL.md tells you _why_ the vendor SDK cannot be consumed directly (two incompatible
wire envelopes, five SDK defects, an unsilenceable console logger); this file tells you what
BAL-467 actually shipped in `apps/api/src/lib/apiroc/` and exactly how to add a new Apiroc call
on top of it. Read it when you are about to write code that talks to Apiroc — BAL-396
(connect / free-busy / events / health probe) or BAL-468 (webhooks / subscription lifecycle).
Everything below is **as-built against commit `eb6d4b2`** unless it is explicitly marked as a
later ticket's job. Evidence tags follow SKILL.md's convention (see "How to read this
document"): **[live]** = observed against the real API in the BAL-393 spike, **[stat]** = read
out of the published SDK bundle, **[docs]** = vendor docs only. Untagged prose is a Balo design
rule or a statement about Balo's own shipped code.

> ⚠ **The boundary ships INERT.** It is constructed, tested, and exported — and **nothing calls
> it yet.** `apps/api/src/routes/calendar/api.ts` is still entirely Cronofy
> (`services/cronofy/oauth.ts`, `lib/cronofy.ts`, `withCronofyRetry`); it does not import
> `lib/apiroc/` at all. You will be the first live caller. There is no in-repo call-site
> precedent to copy, which is what this file substitutes for.

---

## 1. Module map

Everything lives in `apps/api/src/lib/apiroc/`. Six source files, seven test files — the extra
test is the shape tripwire, which has no source module of its own.

| File                | Responsibility                                                                                                                 | Do you touch it to add a call? |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `index.ts`          | The public surface + `callApiroc(operation, fn)`, the one sanctioned call wrapper. Opens the `AsyncLocalStorage` capture sink. | **No** — you import from it    |
| `client.ts`         | Lazy `UnifiedCalendarApi` singleton, `initApirocBoundary`, `ApirocInitReport`                                                  | No                             |
| `errors.ts`         | `ApirocError`, `ApirocConfigError`, `ApirocFailureKind`, `normalizeApirocError`                                                | No                             |
| `interceptor.ts`    | The documented private reach into axios; capture of `x-request-id`, sanitized route template, Envelope B Zod recovery          | No                             |
| `retry.ts`          | `classifyRetry` — pure, no BullMQ coupling                                                                                     | No                             |
| `logging.ts`        | `createLogger('apiroc')` + winston `Console` transport suppression                                                             | No                             |
| `sdk-shape.test.ts` | The tripwire that fails loudly on an SDK/bundler bump (§7)                                                                     | Only on a vendor upgrade       |

**The answer to "which file do I touch to add a new call" is: none of them.** Adding an Apiroc
call is writing a _caller_ — in `services/calendar/`, `services/availability/`, `jobs/`, or a
route — that imports `callApiroc` and `getApirocClient` from this directory. New files under
`lib/apiroc/` are boundary machinery only; feature logic there would also silently enter the
recursive source scan in `sdk-shape.test.ts` (§7).

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
export type {
  ApirocZodIssue,
  ApirocCapture,
  ApirocCaptureSink,
  ApirocInterceptorPosition,
} from './interceptor.js';
export type { ApirocConsoleSuppressionTier } from './logging.js';

export async function callApiroc<T>(operation: string, fn: () => Promise<T>): Promise<T>;
```

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

**Environment.** Today the boundary reads exactly one variable: `APIROC_API_KEY`, present in
`apps/api/.env.example` and in `turbo.json`'s `globalEnv`. `APIROC_APP_ID` and
`APIROC_REDIRECT_URI` belong to the connect flow and are **not yet introduced** — adding them is
BAL-396's job, and they must land in both files (a `globalEnv` omission silently changes the
turbo cache key rather than failing).

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

⚠ **`reconnect_required` is deliberately NOT a kind.** Distinguishing a revoked expert
credential from a bad platform API key — both arrive as 401 / `AuthenticationError` — needs
`wireMessage` composed with the `credential_status` column vocabulary. That is **BAL-396 §2's
job and does not exist yet.** This boundary's contract stops at _classify by status, carry the
raw evidence untouched_. Do not invent your own reading of `wireMessage` in the meantime.

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
| `err.wireMessage`        | **Not yet** — composing it into a reconnect signal is BAL-396 §2. Log it, don't switch on it                                                                                      |

⚠ **The ordering hazard, restated for callers.** If you ever write a second normalizer, a
`catch` that checks a base class before its subclasses silently swallows the specific cases —
`AuthenticationError` _is_ an `instanceof APIRequestError`. The rule is most-specific-first, and
the reason `errors.ts` looks redundant (why check four subclasses when the base would match?) is
exactly this.

⚠ **`ApirocConfigError` is not an `ApirocError`.** A `catch (e) { if (e instanceof ApirocError) … }`
misses it entirely. Handle configuration failure separately, or let it propagate as a 500.

A representative call site (there is no shipped one to copy yet):

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
    if (err.kind === 'unauthorized' || err.kind === 'forbidden') {
      // BAL-396 §2 owns turning this into a reconnect signal — until then, surface, don't guess.
    }
  }
  throw err;
}
```

---

## 5. Retry policy as built

The policy lives in **one place**, `retry.ts::classifyRetry` — pure, no I/O, no BullMQ coupling.
BAL-396/468 map its output onto job options; **that mapping does not exist yet.**

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
   independently scans `lib/apiroc/**`. If your new file lands under `jobs/`,
   `services/availability/`, `services/calendar/`, or `routes/calendar/`, Scans B and E apply too.
10. **Put feature logic outside `lib/apiroc/`.** That directory is the vendor boundary; a new
    file there enters the recursive source scan and reads as boundary machinery to the next
    person.
11. **New env vars go in two places** — `apps/api/.env.example` **and** `turbo.json`'s
    `globalEnv` (that is how `APIROC_API_KEY` shipped).
12. **Test it.** Unit-test the caller with the SDK method mocked; assert the `ApirocError.kind`
    your branches depend on. If you add a repository file, CLAUDE.md requires a matching
    `*.integration.test.ts` in the same PR.

---

## 9. Divergences between SKILL.md and the shipped code

SKILL.md was written before BAL-467 merged; a few of its forward-looking statements are now
stale. Where they conflict, **the shipped code wins** and is described above.

| SKILL.md says                                                                                                                                       | The shipped code does                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "SDK Initialisation" shows `apps/api/src/lib/apiroc.ts` with a module-level `export const apiroc = new UnifiedCalendarApi({...})`                   | A directory `apps/api/src/lib/apiroc/` with a **lazy** `getApirocClient()`. A module-level const would crash the shared Fastify app builder and every route test when `APIROC_API_KEY` is unset                       |
| "Environment variables required: `APIROC_API_KEY`, `APIROC_APP_ID`, `APIROC_REDIRECT_URI`"                                                          | Only `APIROC_API_KEY` exists (`.env.example` + `turbo.json` `globalEnv`). The other two are BAL-396's                                                                                                                 |
| Earlier revisions of "Where the rules live" listed the SDK adapter boundary as pending on BAL-467 and said no `references/*.md` files existed       | BAL-467 merged as `eb6d4b2`. SKILL.md's table was reconciled alongside this file, which is the reference it now points at                                                                                             |
| "Own the boundary — BAL-467 §2" is written as work to do; defects 1 and 3 (400 payload discarded, `requestId` dropped) are described as unmitigated | Both are mitigated as built — `requestId` and the recovered Zod issue array reach the thrown `ApirocError`, pinned end-to-end in `interceptor.test.ts`                                                                |
| The SDK normalisation table is presented as the taxonomy                                                                                            | That is the **SDK's** taxonomy. Balo's is eight `ApirocFailureKind` values; 409 maps to `unknown`, and `reconnect_required` deliberately does not exist yet (BAL-396 §2)                                              |
| "Retry policy: 400 never · 401/403 never · 404 never · 429 back off by `retryAfter` · 5xx and network yes"                                          | Same, plus two as-built refinements: a documented `5000 ms` default when `Retry-After` is absent, and `unknown` **fails closed**                                                                                      |
| "The boundary must patch or replace that transport"                                                                                                 | One tier, as built: override `winston.transports.Console.prototype.log`, via a `require` rooted at the SDK's own resolved path. Safe only because no Balo package declares winston — a premise `logging.test.ts` pins |
