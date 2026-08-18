import {
  APIRequestError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  UnifiedCalendarApiError,
} from '@apiroc/unified-calendar-api-node-sdk';
import { readApirocCapture, type ApirocCapture, type ApirocZodIssue } from './interceptor.js';

/**
 * Thrown when Apiroc configuration is missing (e.g. `APIROC_API_KEY` unset). Mirrors
 * `services/stripe/errors.ts::StripeConfigError` and `services/airwallex/errors.ts` — a named
 * error so a misconfiguration surfaces loudly (a throw, never a silent `!` non-null
 * assertion).
 */
export class ApirocConfigError extends Error {
  constructor(detail: string) {
    super(`Apiroc configuration error: ${detail}`);
    this.name = 'ApirocConfigError';
    Object.setPrototypeOf(this, ApirocConfigError.prototype);
  }
}

/**
 * Balo's normalized Apiroc failure taxonomy (BAL-467 §4d). Exactly one kind per HTTP status
 * class. `reconnect_required` is DELIBERATELY not a kind here — see `normalizeApirocError`'s
 * docblock. No adapter code may branch on the wire `error` field: it has been observed as the
 * string `"Error"`, the number `404`, `"InvalidRefreshToken"`, `"InternalServerError"`, and a
 * `ZodError` object — a `string | number | object` union, not an enum.
 */
export type ApirocFailureKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'unknown';

export interface ApirocErrorParams {
  readonly kind: ApirocFailureKind;
  readonly operation: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly zodIssues?: ReadonlyArray<ApirocZodIssue>;
  readonly wireMessage?: string;
  readonly wireErrorRaw?: unknown;
  readonly cause?: unknown;
}

/**
 * Balo-shaped failure every future Apiroc call site (BAL-396, BAL-468) consumes instead of the
 * SDK's mangled one. Carries the raw wire evidence (`wireMessage`, `wireErrorRaw`) UNTOUCHED —
 * this boundary classifies by HTTP status only and deliberately does not interpret them; the
 * next slice composes on top (see `kind`'s docblock).
 */
export class ApirocError extends Error {
  readonly kind: ApirocFailureKind;
  readonly operation: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly zodIssues?: ReadonlyArray<ApirocZodIssue>;
  readonly wireMessage?: string;
  /** UNKNOWN and UNPARSED — log-only evidence. Never compare this to a literal (BAL-467 §4d). */
  readonly wireErrorRaw?: unknown;

  constructor(params: ApirocErrorParams) {
    super(`Apiroc ${params.operation} failed (${params.kind})`, { cause: params.cause });
    this.name = 'ApirocError';
    this.kind = params.kind;
    this.operation = params.operation;
    this.status = params.status;
    this.requestId = params.requestId;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.zodIssues = params.zodIssues;
    this.wireMessage = params.wireMessage;
    // B2 (security review) — `wireErrorRaw` holds the raw wire body, which on Envelope B
    // can echo rejected `events.create` input (event titles, attendee addresses). A plain
    // `this.wireErrorRaw = …` assignment makes it an OWN ENUMERABLE property, and Pino's
    // default `err` serializer copies own enumerable properties via `for…in` — so the
    // first CLAUDE.md-mandated `log.error({ err })` in BAL-396 would serialise the entire
    // raw body straight to Axiom. `enumerable: false` keeps `err.wireErrorRaw` readable to
    // any caller/test that reads it directly (`configurable`/`writable` stay `true`), while
    // removing it from `for…in` / `JSON.stringify` / the Pino serializer's copy loop.
    Object.defineProperty(this, 'wireErrorRaw', {
      value: params.wireErrorRaw,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.setPrototypeOf(this, ApirocError.prototype);
  }
}

/**
 * Classifies a genuine `APIRequestError` instance's status — i.e. a status the SDK's own
 * switch statement did NOT recognize as 401/403/404/429 (those always throw the specific
 * subclass instead; see `dist/index.js`'s response-interceptor `switch`). 400 → validation,
 * 5xx → server_error, everything else (409, other) → unknown.
 *
 * ⚠ DELIBERATELY does NOT map 401/403/404/429 to their kinds here, even though it could
 * (coincidentally producing the right answer) — this is the ordering test's teeth
 * (`errors.test.ts`). If the `instanceof` chain above is ever reordered so that
 * `APIRequestError` is checked before its four subclasses, a real 401 would reach this
 * function and — mapped narrowly — surface as `'unknown'` instead of silently and
 * coincidentally still saying `'unauthorized'`. A `plain` `APIRequestError` legitimately
 * carrying 401/403/404/429 should never happen; treating it as `'unknown'` is honest, not a
 * regression.
 */
function classifyApiRequestErrorStatus(status: number): ApirocFailureKind {
  if (status === 400) return 'validation';
  if (status >= 500 && status < 600) return 'server_error';
  return 'unknown';
}

function captureFields(
  capture: ApirocCapture | undefined
): Pick<ApirocErrorParams, 'requestId' | 'zodIssues' | 'wireMessage' | 'wireErrorRaw'> {
  return {
    requestId: capture?.requestId,
    zodIssues: capture?.zodIssues,
    wireMessage: capture?.wireMessage,
    wireErrorRaw: capture?.wireErrorRaw,
  };
}

/**
 * `status`/`response.status` fallback — used ONLY to populate the `status` field on the
 * resulting `ApirocError` for observability when `err` is not one of the six recognized SDK
 * classes. It never reclassifies `kind`: an unrecognized shape is always `kind: 'unknown'`,
 * `retry: false` (fail closed), regardless of what status happens to be present — a 400
 * arriving in a shape the SDK never actually produces is not evidence we understand it.
 */
function extractFallbackStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const direct = (err as { status?: unknown }).status;
  if (typeof direct === 'number') {
    return direct;
  }
  const response = (err as { response?: unknown }).response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
}

/**
 * Classifies by HTTP status only, `instanceof`-ordered MOST-SPECIFIC-FIRST — all four
 * subclasses extend `APIRequestError`, which extends `UnifiedCalendarApiError`
 * (`RateLimitError → NotFoundError → AuthorizationError → AuthenticationError →
 * APIRequestError → UnifiedCalendarApiError → unrecognized shape → 'unknown'`).
 * `Object.setPrototypeOf` runs in every SDK constructor so `instanceof` is reliable. NEVER
 * branch on `error.constructor.name` (bundler-mangled to `_AuthenticationError`) and NEVER
 * read the wire `error` field as an enum.
 *
 * ⚠ `reconnect_required` is DELIBERATELY not a kind produced here. Distinguishing a revoked
 * expert credential from a bad platform API key — both arrive as 401/`AuthenticationError` —
 * needs `wireMessage` composed with the `credential_status` column vocabulary, which is
 * BAL-396 §2's job. This boundary's contract stops at: classify by status; carry the raw
 * evidence untouched so the next slice can compose on it.
 *
 * @param explicitCapture — passed by `callApiroc` (`index.ts`) from its `AsyncLocalStorage`
 * capture sink. PREFERRED over `readApirocCapture(err)` when present: the SDK's own
 * response interceptor constructs a brand-new error object for every recognized status
 * class and never forwards `config`/`response` onto it (see the CRITICAL #1 docblock on
 * `ApirocCaptureSink` in `interceptor.ts`), so `readApirocCapture(err)` reliably finds
 * nothing on that object in production — it remains a fallback for direct callers that
 * bypass `callApiroc` and construct/annotate the same error object by hand (as the unit
 * tests in `errors.test.ts` do).
 */
export function normalizeApirocError(
  err: unknown,
  operation: string,
  explicitCapture?: ApirocCapture
): ApirocError {
  const capture = explicitCapture ?? readApirocCapture(err);

  if (err instanceof RateLimitError) {
    return new ApirocError({
      kind: 'rate_limited',
      operation,
      status: 429,
      retryAfterSeconds: err.retryAfter,
      cause: err,
      ...captureFields(capture),
    });
  }
  if (err instanceof NotFoundError) {
    return new ApirocError({
      kind: 'not_found',
      operation,
      status: 404,
      cause: err,
      ...captureFields(capture),
    });
  }
  if (err instanceof AuthorizationError) {
    return new ApirocError({
      kind: 'forbidden',
      operation,
      status: 403,
      cause: err,
      ...captureFields(capture),
    });
  }
  if (err instanceof AuthenticationError) {
    return new ApirocError({
      kind: 'unauthorized',
      operation,
      status: 401,
      cause: err,
      ...captureFields(capture),
    });
  }
  if (err instanceof APIRequestError) {
    return new ApirocError({
      kind: classifyApiRequestErrorStatus(err.status),
      operation,
      status: err.status,
      cause: err,
      ...captureFields(capture),
    });
  }
  if (err instanceof UnifiedCalendarApiError) {
    return new ApirocError({
      kind: 'network',
      operation,
      cause: err,
      ...captureFields(capture),
    });
  }

  return new ApirocError({
    kind: 'unknown',
    operation,
    status: extractFallbackStatus(err),
    cause: err,
    ...captureFields(capture),
  });
}
