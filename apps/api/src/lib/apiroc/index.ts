/**
 * The Apiroc SDK adapter boundary (BAL-467 §4). Ships INERT in this ticket — constructed and
 * tested, with no live caller. Every future Apiroc call (BAL-396 connect/free-busy/events,
 * BAL-468 webhooks) goes through `callApiroc` so it consumes a Balo-shaped `ApirocError`
 * instead of the SDK's mangled one.
 */
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

import { log } from './logging.js';
import { normalizeApirocError } from './errors.js';
import { runWithApirocCaptureSink, type ApirocCaptureSink } from './interceptor.js';

/**
 * The one sanctioned call site for an Apiroc SDK method. `operation` is a short, stable label
 * (e.g. `'calendars.list'`) for logs and future retry/telemetry — not read from the wire.
 *
 * Opens an `AsyncLocalStorage` capture sink around `fn()` (BAL-467 review CRITICAL #1 fix —
 * see the docblock on `ApirocCaptureSink` in `interceptor.ts`) so that whatever
 * `captureApirocFailure` captures off the RAW axios error reaches `normalizeApirocError`
 * regardless of what error object the SDK's own interceptor ultimately throws. `sink` is
 * read here by closure reference, not via `getStore()` — the ALS context has already
 * unwound by the time this `catch` runs.
 *
 * ⚠ CONTRACT: `fn` must wrap exactly ONE SDK call that can fail. A `fn` that internally
 * swallows an Apiroc failure and then throws something else, or that fans out multiple
 * concurrent Apiroc calls (`Promise.all(...)`), can cause more than one capture to land in
 * the sink for this single `callApiroc` invocation — see the `ApirocCaptureSink` docblock in
 * `interceptor.ts` for the two reachable shapes. In that case NO capture is attached (evidence
 * would be attributed to the wrong error) and `apiroc_capture_ambiguous` is logged instead —
 * callers doing a fan-out must catch/normalize per-call, not wrap the whole `Promise.all` in
 * one `callApiroc`.
 *
 * Inert in this PR — no caller ships.
 */
export async function callApiroc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const sink: ApirocCaptureSink = { captures: [] };
  try {
    return await runWithApirocCaptureSink(sink, fn);
  } catch (err: unknown) {
    const [capture] = sink.captures;
    if (sink.captures.length > 1) {
      log.warn(
        {
          operation,
          count: sink.captures.length,
          requestIds: sink.captures.map((c) => c.requestId),
        },
        'apiroc_capture_ambiguous'
      );
      throw normalizeApirocError(err, operation, undefined);
    }
    throw normalizeApirocError(err, operation, capture);
  }
}
