import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from './logging.js';

/**
 * ⚠ DOCUMENTED PRIVATE REACH — one of the rare justified WHY comments.
 *
 * `UnifiedCalendarApi.baseClient` and `BaseClient.client` are BOTH declared `private` in
 * `@apiroc/unified-calendar-api-node-sdk@2.0.1` (`dist/index.d.ts:751` and `:526`). There is
 * no supported accessor. We reach anyway because the SDK's own response interceptor
 * (registered in `BaseClient`'s constructor, before we ever get a handle on the instance)
 * destroys the two things vendor escalation and 400-debugging need (apiroc skill, "Five SDK
 * defects" 1 & 3):
 *   · `x-request-id` — on EVERY response header, copied onto no thrown error;
 *   · the Envelope B body — `{ success:false, error:{ name:'ZodError', message:<double-encoded> } }`
 *     — discarded because the SDK reads `data?.message`, which Envelope B does not have.
 * A call wrapper alone (never touching the axios instance) sees only
 * "Request failed with status code 400".
 *
 * EVERY hop is optional-chained and shape-checked. `installInterceptor` NEVER throws and is
 * NEVER called at module load — only from `client.ts`'s lazy `getApirocClient()` path. On any
 * shape mismatch it returns a report with `interceptorInstalled: false` and the boundary
 * degrades to status-only branching in `errors.ts` — which is exactly what a call-wrapper-only
 * design would have given us, so the failure mode is "less detail", never "broken".
 *
 * `sdk-shape.test.ts` pins this shape so an SDK or bundler bump fails LOUDLY in CI rather than
 * silently degrading in production.
 */

/** Minimal structural shape of what we need from axios — deliberately NOT `import type` from
 * the `axios` package: `axios` is a transitive dependency of the Apiroc SDK, not a direct
 * dependency of `apps/api`, so pnpm's strict node_modules does not expose its types here. Duck
 * typing this is also the architecturally honest choice — we only ever reach through a shape
 * check, never a supported type. */
interface AxiosInterceptorHandlerLike {
  readonly fulfilled?: unknown;
  readonly rejected?: unknown;
}

interface AxiosResponseInterceptorManagerLike {
  handlers: Array<AxiosInterceptorHandlerLike | null>;
  use: (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (error: unknown) => unknown
  ) => number;
}

interface AxiosInstanceLike {
  interceptors: {
    response: AxiosResponseInterceptorManagerLike;
  };
}

interface AxiosErrorLike {
  message?: string;
  config?: Record<string, unknown> & { method?: string; url?: string };
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    data?: unknown;
  };
}

function isAxiosInstanceLike(candidate: unknown): candidate is AxiosInstanceLike {
  // ⚠ axios instances (from `axios.create()`) are CALLABLE — `typeof candidate === 'function'`,
  // not `'object'` (confirmed against the SDK's installed axios@1.19.0: `Object.assign` layers
  // the HTTP-verb methods and `interceptors` onto a bound `Axios#request` function). Excluding
  // `'function'` here would make hop 2 fail on every real instance, degrading straight to the
  // "shape absent" branch in production.
  if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) {
    return false;
  }
  const interceptors = (candidate as { interceptors?: unknown }).interceptors;
  if (typeof interceptors !== 'object' || interceptors === null) {
    return false;
  }
  const response = (interceptors as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) {
    return false;
  }
  return typeof (response as { use?: unknown }).use === 'function';
}

export interface ReachAxiosInstanceResult {
  readonly axiosInstance: AxiosInstanceLike | null;
  readonly reachedBaseClient: boolean;
  readonly reachedClient: boolean;
}

/**
 * Hop 1 (`api.baseClient`) then hop 2 (`baseClient.client`) — both optional-chained, both
 * shape-checked. Never throws.
 */
export function reachAxiosInstance(api: unknown): ReachAxiosInstanceResult {
  const baseClient =
    typeof api === 'object' && api !== null
      ? (api as Record<string, unknown>).baseClient
      : undefined;
  const reachedBaseClient = typeof baseClient === 'object' && baseClient !== null;

  const client = reachedBaseClient ? (baseClient as Record<string, unknown>).client : undefined;
  const reachedClient = isAxiosInstanceLike(client);

  return {
    axiosInstance: reachedClient ? (client as AxiosInstanceLike) : null,
    reachedBaseClient,
    reachedClient,
  };
}

export interface ApirocZodIssue {
  readonly path: string;
  readonly code?: string;
  readonly message?: string;
}

export interface ApirocCapture {
  readonly status?: number;
  readonly requestId?: string;
  readonly method?: string;
  readonly url?: string;
  /** UNKNOWN and UNPARSED — never interpreted, never switched on. Log-only evidence. */
  readonly wireErrorRaw: unknown;
  readonly wireMessage?: string;
  readonly zodIssues?: ReadonlyArray<ApirocZodIssue>;
}

const CAPTURE_KEY = '__apirocCapture__';

function isApirocCapture(value: unknown): value is ApirocCapture {
  return typeof value === 'object' && value !== null && 'wireErrorRaw' in value;
}

/** Best-effort, non-enumerable annotation. May not survive to `normalizeApirocError` — the
 * SDK's own response interceptor (which always runs after ours, since it registered first)
 * constructs a BRAND NEW Error subclass and does not forward `config`/`response` onto it. The
 * load-bearing guarantee is the immediate Pino log below, not this annotation — see the
 * module docblock. */
function attachCapture(target: unknown, capture: ApirocCapture): void {
  if (typeof target !== 'object' || target === null) {
    return;
  }
  try {
    Object.defineProperty(target, CAPTURE_KEY, {
      value: capture,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Never throw from inside an interceptor.
  }
}

/** Reads a capture off either the error itself or `error.config` — "whichever survives". */
export function readApirocCapture(err: unknown): ApirocCapture | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const direct = (err as Record<string, unknown>)[CAPTURE_KEY];
  if (isApirocCapture(direct)) {
    return direct;
  }
  const config = (err as { config?: unknown }).config;
  if (typeof config === 'object' && config !== null) {
    const fromConfig = (config as Record<string, unknown>)[CAPTURE_KEY];
    if (isApirocCapture(fromConfig)) {
      return fromConfig;
    }
  }
  return undefined;
}

/**
 * ⚠⚠ CRITICAL #1 (BAL-467 review, re-derived — the original text was lost to output
 * truncation; see the fix brief) — WHY THIS SIDE CHANNEL EXISTS.
 *
 * Verified against the INSTALLED SDK (`@apiroc/unified-calendar-api-node-sdk@2.0.1`,
 * `dist/index.js`): the SDK's own response interceptor — which runs immediately AFTER ours
 * in the axios chain, since it was registered first and we only reorder OUR handler ahead
 * of it — does not `return Promise.reject(rawError)`. It `throw`s a BRAND NEW error
 * instance: `new AuthenticationError(message)`, `new AuthorizationError(message)`, `new
 * NotFoundError(message)`, `new RateLimitError(message, retryAfter)`, or `new
 * APIRequestError(message, status, code, details)`. Reading every one of those five
 * constructors in `dist/index.js` confirms NONE of them accepts or stores `config` or
 * `response`. So the best-effort annotation `attachCapture` writes onto the RAW error and
 * its `config` (below) is not merely "may not survive" — for EVERY status class the SDK
 * recognizes (401/403/404/429/anything else via `APIRequestError`), it is GUARANTEED lost,
 * deterministically, on every single failure. `readApirocCapture(err)` alone can therefore
 * never satisfy "every thrown Apiroc error carries requestId" — it only ever appears to
 * work in a test that (unlike production) calls `captureApirocFailure` and
 * `normalizeApirocError` on the SAME object reference.
 *
 * The fix is a side channel that does not depend on ANY property surviving onto the SDK's
 * replacement error object. `callApiroc` (`index.ts`) opens an `AsyncLocalStorage` context
 * around the whole `fn()` call, holding a small mutable sink object BY REFERENCE (not via
 * `getStore()` on the way out — the ALS context has already unwound by the time
 * `callApiroc`'s `catch` runs). `captureApirocFailure` always executes as a promise
 * continuation of that same `fn()` call — even though the SDK constructs a new error two
 * handlers later, the ASYNC CONTEXT it runs inside is unaffected by that — so
 * `captureContext.getStore()` inside `captureApirocFailure` reliably resolves to the SAME
 * sink object `callApiroc` is holding, and writes the capture into it directly. This is
 * correct under CONCURRENT `callApiroc` calls: each invocation opens its own store, and
 * Node's `AsyncLocalStorage` isolates concurrent overlapping contexts by construction — a
 * shared module-level variable (or a stack) would not be, since two in-flight calls' leading
 * and trailing interceptor invocations can interleave in either order.
 *
 * ⚠ BAL-467 fix brief round 2, item 3 — the sink ACCUMULATES rather than holding a single
 * overwritable `capture` slot. A single slot is last-write-wins WITHIN one `callApiroc`
 * context, and two reachable shapes measured by the reviewer prove that is wrong:
 *
 *   1. `fn` internally catches an Apiroc failure (so ITS interceptor runs and captures) and
 *      then throws an unrelated local error — the single slot would still hold the swallowed
 *      failure's evidence, misattaching a foreign `requestId` to the thrown error.
 *   2. A fan-out `fn` (e.g. BAL-396's `freeBusy.union` — `Promise.all(conns.map(...))`) where
 *      TWO calls fail concurrently — the single slot holds whichever capture ran last, not
 *      necessarily the one `fn` actually rethrows, so one expert's raw wire body could land
 *      on another expert's error.
 *
 * `callApiroc` (`index.ts`) only forwards a capture to `normalizeApirocError` when exactly
 * one was recorded in the context; two or more is treated as ambiguous — see `index.ts`.
 */
export interface ApirocCaptureSink {
  readonly captures: ApirocCapture[];
}

const captureContext = new AsyncLocalStorage<ApirocCaptureSink>();

/** `callApiroc`'s entry point (`index.ts`) — not intended for any other caller. */
export function runWithApirocCaptureSink<T>(
  sink: ApirocCaptureSink,
  fn: () => Promise<T>
): Promise<T> {
  return captureContext.run(sink, fn);
}

/**
 * The Apiroc SDK embeds the caller-supplied `endUserAccountId` (an opaque pointer, fine to
 * log) AND, for Google accounts, the `calendarId` — which the provider-parity table (apiroc
 * skill) confirms IS the expert's Google account email address — directly in the URL path,
 * e.g. `/api/v1/events/{endUserAccountId}/{calendarId}`. Logging `err.config.url` verbatim
 * therefore writes an expert's personal email address to stdout and Axiom on every failed
 * calendar/event call (security review WARNING, `interceptor.ts:248`).
 *
 * Keeps the API version and resource segments (stable, non-identifying — useful for
 * grep/alerting) and collapses everything after them to a count, never the raw value. Never
 * throws; an unparseable input degrades to `undefined`.
 *
 * ⚠ Fix brief round 2, item 9 — `ROUTE_TEMPLATE_KEPT_SEGMENTS = 3` is correct against SDK
 * 2.0.1 (all 11 request paths are `/api/v1/<resource>/…` — `sdk-shape.test.ts` pins that
 * premise) but was UNPINNED here: a future SDK version emitting e.g.
 * `/events/{endUserAccountId}/{calendarId}` would keep three segments and log the expert's
 * Google email verbatim. Defence in depth below: any KEPT segment that itself looks like an
 * email (contains `@` or its URL-encoded form `%40`) is redacted regardless of position —
 * this does not depend on `ROUTE_TEMPLATE_KEPT_SEGMENTS` staying correct.
 */
const ROUTE_TEMPLATE_KEPT_SEGMENTS = 3; // e.g. "api", "v1", "events"
const EMAIL_MARKERS = ['@', '%40'] as const;

function looksLikeEmailSegment(segment: string): boolean {
  return EMAIL_MARKERS.some((marker) => segment.includes(marker));
}

function sanitizeRouteTemplate(url: string | undefined): string | undefined {
  if (typeof url !== 'string' || url.length === 0) {
    return url;
  }
  const [pathPart] = url.split('?');
  if (!pathPart) {
    return undefined;
  }
  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  const kept = segments
    .slice(0, ROUTE_TEMPLATE_KEPT_SEGMENTS)
    .map((segment) => (looksLikeEmailSegment(segment) ? '[redacted:email]' : segment));
  const redactedCount = segments.length - kept.length;
  const template = `/${kept.join('/')}`;
  return redactedCount > 0 ? `${template}/[redacted:${redactedCount}]` : template;
}

function extractHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return typeof value === 'string' ? value : undefined;
}

function extractWireMessage(
  wireErrorRaw: unknown,
  fallback: string | undefined
): string | undefined {
  if (typeof wireErrorRaw === 'object' && wireErrorRaw !== null) {
    const message = (wireErrorRaw as Record<string, unknown>).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return fallback;
}

/**
 * Envelope B's `error.message` is a DOUBLE-ENCODED JSON string of a Zod issue array (skill,
 * Error Handling section). A parse failure degrades to `undefined` — never throws inside an
 * interceptor (edge case 7).
 */
function parseZodIssues(wireErrorRaw: unknown): ReadonlyArray<ApirocZodIssue> | undefined {
  if (typeof wireErrorRaw !== 'object' || wireErrorRaw === null) {
    return undefined;
  }
  const errorField = (wireErrorRaw as Record<string, unknown>).error;
  if (typeof errorField !== 'object' || errorField === null) {
    return undefined;
  }
  const message = (errorField as Record<string, unknown>).message;
  if (typeof message !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(message);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed
      .filter(
        (issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null
      )
      .map((issue) => {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path ?? '');
        const code = typeof issue.code === 'string' ? issue.code : undefined;
        const issueMessage = typeof issue.message === 'string' ? issue.message : undefined;
        return { path, code, message: issueMessage };
      });
  } catch {
    return undefined;
  }
}

/**
 * The non-destructive capture step: reads what the wire actually sent, logs it through Pino
 * IMMEDIATELY (the order-independent guarantee — this is what satisfies "the Zod issue array
 * is recovered and logged with field paths" even when the annotation below is lost further
 * down the chain), then best-effort annotates the error for `normalizeApirocError` to recover
 * later if it can.
 *
 * ⚠ Never logs the request body, `authorization`, or `apiKey` — only response-side wire
 * evidence.
 */
export function captureApirocFailure(error: unknown): ApirocCapture | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const err = error as AxiosErrorLike;
  const status = err.response?.status;
  const requestId = extractHeader(err.response?.headers, 'x-request-id');
  const method = err.config?.method;
  // ⚠ SANITIZED, NOT RAW — see sanitizeRouteTemplate's docblock. Neither the in-memory
  // capture nor the log line ever carries the real path past the resource segment, so a
  // future consumer of `ApirocCapture.url` cannot accidentally re-introduce the leak.
  const url = sanitizeRouteTemplate(err.config?.url);
  const wireErrorRaw = err.response?.data;
  const wireMessage = extractWireMessage(wireErrorRaw, err.message);
  const zodIssues = status === 400 ? parseZodIssues(wireErrorRaw) : undefined;

  const capture: ApirocCapture = {
    status,
    requestId,
    method,
    url,
    wireErrorRaw,
    wireMessage,
    zodIssues,
  };

  log.error(
    {
      status,
      requestId,
      method,
      url,
      zodIssuePaths: zodIssues?.map((issue) => issue.path),
      wireMessage,
    },
    'apiroc_request_failed'
  );

  attachCapture(err, capture);
  if (err.config) {
    attachCapture(err.config, capture);
  }

  // The LOAD-BEARING guarantee (CRITICAL #1 fix) — see the docblock above
  // `ApirocCaptureSink`. `attachCapture` above is kept as a defence-in-depth annotation for
  // any caller that bypasses `callApiroc`, but it is not what makes the AC hold in
  // production. Accumulates (item 3, round 2) — `callApiroc` decides what to do with more
  // than one capture; this interceptor's only job is to record every failure it observes.
  const sink = captureContext.getStore();
  if (sink) {
    sink.captures.push(capture);
  }

  return capture;
}

export type ApirocInterceptorPosition = 'first' | 'appended' | 'none';

export interface ApirocInterceptorReport {
  readonly interceptorInstalled: boolean;
  readonly interceptorPosition: ApirocInterceptorPosition;
  readonly reachedBaseClient: boolean;
  readonly reachedClient: boolean;
}

/**
 * Registers our capture-and-rethrow handler via the PUBLIC `.use()`, then attempts to move it
 * to the front of the handler chain — the SDK registers its own response interceptor in the
 * `BaseClient` constructor, and axios runs response-rejection handlers in registration order,
 * so an appended handler would only ever see the SDK's own already-mangled error (no headers,
 * no response body). If the reorder is not possible the handler stays appended and that is
 * reported and warned, never thrown.
 */
export function installInterceptor(api: unknown): ApirocInterceptorReport {
  const { axiosInstance, reachedBaseClient, reachedClient } = reachAxiosInstance(api);

  if (!axiosInstance) {
    log.warn({ reachedBaseClient, reachedClient }, 'apiroc_interceptor_reach_failed');
    return {
      interceptorInstalled: false,
      interceptorPosition: 'none',
      reachedBaseClient,
      reachedClient,
    };
  }

  axiosInstance.interceptors.response.use(
    (value: unknown) => value,
    (error: unknown) => {
      captureApirocFailure(error);
      return Promise.reject(error);
    }
  );

  const handlers = axiosInstance.interceptors.response.handlers;
  let position: ApirocInterceptorPosition = 'appended';

  if (Array.isArray(handlers) && handlers.length <= 1) {
    // D2: we are the ONLY registered handler (a future SDK version that stops registering
    // its own would land here). We are trivially already first — no reorder is possible or
    // needed. Leaving `position` at 'appended' here was a permanent false alarm
    // (`apiroc_interceptor_order_degraded`) on a chain that was correctly ordered.
    position = 'first';
  } else if (Array.isArray(handlers) && handlers.length >= 2 && handlers[handlers.length - 1]) {
    const ours = handlers.pop();
    if (ours) {
      handlers.unshift(ours);
      // Fix brief round 2, item 8 — `handlers` is the SAME array object as
      // `axiosInstance.interceptors.response.handlers` (a plain property, not a getter that
      // could return a fresh copy), so `handlers[0] === ours` immediately after
      // `unshift(ours)` is guaranteed by `Array.prototype.unshift` itself — it verified
      // nothing (round-1's claim of "confirm by REFERENCE IDENTITY" was false; the ternary
      // this replaced was a tautology, and `apiroc_interceptor_order_degraded` below was
      // unreachable from this branch as a result). Set the honest, unconditional outcome
      // instead of pretending to re-verify a guarantee the language already gives us.
      //
      // D3 (still true, still undetectable from here): a future SDK version that calls
      // `eject()` on its OWN remembered `.use()` id — now stale, since this swap changed
      // which handler that positional index addresses — would silently null OUR handler
      // (`forEach` skips nulls; nothing crashes, capture just stops). No code at this call
      // site can observe that happening later; it is a permanent, documented limitation.
      position = 'first';
    }
  }

  if (position !== 'first') {
    log.warn(
      { handlerCount: Array.isArray(handlers) ? handlers.length : -1 },
      'apiroc_interceptor_order_degraded'
    );
  }

  return {
    interceptorInstalled: true,
    interceptorPosition: position,
    reachedBaseClient,
    reachedClient,
  };
}
