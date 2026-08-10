/**
 * Sentry URL scrubbing — the THIRD sink for the token-in-URL secrets (BAL-386 / BAL-390 /
 * BAL-408).
 *
 * ⚠ WHY THIS FILE EXISTS. `redactSensitivePath` was wired into exactly two sinks — the Edge
 * middleware request log and the PostHog client — while Sentry, which captures URLs on FOUR
 * independent channels, was left completely unscrubbed. Three of those channels are
 * ALWAYS-ON and need no error to fire:
 *
 *   1. `contexts.nextjs.request_path` — `@sentry/nextjs`'s `captureRequestError` does
 *      `scope.setContext('nextjs', { request_path: request.path, … })`, and Next hands
 *      `onRequestError` the RESOLVED resource path (`/join/{raw token}`), NOT the
 *      parameterised `/join/[token]`. Any server-side throw inside the page — a DB blip in
 *      `meetingContextsRepository.listByMeeting`, a write timeout in `recordAccess` — ships
 *      the raw credential.
 *   2. `request.url` — the browser SDK fills this from `location.href`.
 *   3. Session Replay — `replay_event.urls` plus the recording stream itself.
 *   4. `tracesSampleRate` pageload transactions, whose span attributes carry the full href.
 *
 * ⚠ `sendDefaultPii: false` GATES NONE OF THESE. It governs cookies, headers and IP only.
 *
 * ⚠ AND IT MATTERS MORE HERE THAN FOR THE OTHER TWO PREFIXES. The guest join token is
 * deliberately NOT single-use (desktop → phone → rejoin after a network drop), so it stays
 * replayable for the whole `GUEST_TOKEN_TTL_AFTER_END_MS` (7-day) window. One captured
 * session replay is a LIVE CREDENTIAL, not a stale log line.
 *
 * ── ONE DEFINITION, THREE RUNTIMES ──────────────────────────────────────────────
 * `sentryScrubbingOptions` is spread into `sentry.server.config.ts`, `sentry.edge.config.ts`
 * and `instrumentation-client.ts`. It is a SHARED OBJECT rather than three inlined copies
 * both because a fourth channel must only need one edit, and because three hand-written
 * copies of the same ~40 lines is precisely SonarCloud's >3% new-code duplication gate.
 *
 * ⚠ NO `@sentry/*` IMPORT, ON PURPOSE. Every export here is a generic `<T>(x: T) => T`
 * operating on plain structural shapes, which means (a) it is assignable to `beforeSend`,
 * `beforeSendTransaction`, `beforeBreadcrumb`, `addEventProcessor` and
 * `beforeAddRecordingEvent` alike without importing five SDK types that move between major
 * versions, (b) the unit tests construct synthetic events with no SDK bootstrap, and (c)
 * this module stays in the CLIENT bundle at near-zero cost. `@balo/shared/redaction` is
 * pure, dependency-free and carries no `node:` import or `server-only` marker, so the same
 * file is safe in the browser, in Node and on the Edge.
 */
import { redactSensitivePath } from '@balo/shared/redaction';

/**
 * Keys inside a `data` bag whose value is a URL.
 *
 * Covers three vocabularies at once because one bag shape is reused across all of them:
 * Sentry breadcrumbs (`url` on fetch/xhr, `from`/`to` on navigation), OpenTelemetry span
 * attributes (`url.full`, `http.url`, `http.target` — the ones a pageload/navigation
 * transaction actually carries), and replay performance frames.
 */
const URL_DATA_KEYS: readonly string[] = [
  'url',
  'to',
  'from',
  'href',
  'url.full',
  'http.url',
  'http.target',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Redact `bag[key]` in place when it is a string; ignore every other type.
 *
 * Mutation is deliberate: Sentry hands these hooks the live event object and expects the
 * same object back, and rebuilding one structurally would silently drop the SDK's
 * non-enumerable bookkeeping.
 */
function redactStringAt(bag: Record<string, unknown>, key: string): void {
  const value = bag[key];
  if (typeof value === 'string') {
    bag[key] = redactSensitivePath(value);
  }
}

/** Redact every known URL-bearing key of a `data` bag, if there is one. */
function redactUrlKeys(bag: unknown): void {
  if (!isRecord(bag)) return;
  for (const key of URL_DATA_KEYS) {
    redactStringAt(bag, key);
  }
}

/**
 * Redact `bag.urls` in place when it is an array of URLs, leaving non-strings alone.
 *
 * ⚠ TAKES `bag` AS A PLAIN `Record` FOR A TYPE REASON, not a stylistic one. Inside a generic
 * `<T>` the narrowed value is `T & Record<string, unknown>`, and TypeScript refuses to WRITE
 * a property to that intersection (reads go through the index signature, writes do not) —
 * `event.urls = …` is a `TS2339`. Widening to `Record<string, unknown>` at this boundary
 * keeps the write legal without an `as` cast anywhere.
 */
function redactUrlList(bag: Record<string, unknown>, urls: unknown): void {
  if (!Array.isArray(urls)) return;
  bag.urls = urls.map((url: unknown) => (typeof url === 'string' ? redactSensitivePath(url) : url));
}

/** Apply `visit` to every record in `maybeList`, tolerating a missing or malformed list. */
function forEachRecord(maybeList: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (!Array.isArray(maybeList)) return;
  for (const item of maybeList) {
    if (isRecord(item)) visit(item);
  }
}

/** A breadcrumb carries its URLs in `data`; `message` can restate one. */
function redactBreadcrumbFields(crumb: Record<string, unknown>): void {
  redactUrlKeys(crumb.data);
  redactStringAt(crumb, 'message');
}

/** A span carries its URLs in `data` (attributes); `description` is often the bare URL. */
function redactSpanFields(span: Record<string, unknown>): void {
  redactUrlKeys(span.data);
  redactStringAt(span, 'description');
}

/**
 * Scrub every URL-bearing position of a Sentry event, in place.
 *
 * Wired THREE ways, because no single hook sees every event type:
 *   - `beforeSend`            → error events
 *   - `beforeSendTransaction` → transaction events (the `tracesSampleRate` pageloads)
 *   - `addEventProcessor`     → everything the two hooks above never see, and the reason
 *     this is not redundant: a `replay_event` is assembled by the Replay integration's own
 *     `prepareReplayEvent`, which runs `prepareEvent` (and therefore the global event
 *     processors) but NEVER `beforeSend`. `urls` below is reachable only this way.
 *
 * Safe to run more than once — `redactSensitivePath` is idempotent — which matters because
 * an event genuinely does pass through both a processor and a `beforeSend*` hook.
 */
export function scrubSentryEvent<T>(event: T): T {
  if (!isRecord(event)) return event;

  const request = event.request;
  if (isRecord(request)) {
    redactStringAt(request, 'url');
    // `Referer` is the one header that can carry another page's secret path. Present only
    // when `sendDefaultPii` is on (dev), so this is belt-and-braces for local captures.
    if (isRecord(request.headers)) {
      redactStringAt(request.headers, 'Referer');
      redactStringAt(request.headers, 'referer');
    }
  }

  // ⚠ THE `captureRequestError` CHANNEL — the always-on server-side leak. See the module
  // docblock: Next passes the RESOLVED path here, so this is `/join/{raw token}`.
  const contexts = event.contexts;
  if (isRecord(contexts)) {
    if (isRecord(contexts.nextjs)) redactStringAt(contexts.nextjs, 'request_path');
    // The root span's attributes live on `contexts.trace.data`, not in `spans`.
    if (isRecord(contexts.trace)) redactUrlKeys(contexts.trace.data);
  }

  // Usually the parameterised route, but a client-side pageload can name the raw URL.
  redactStringAt(event, 'transaction');
  redactStringAt(event, 'message');

  forEachRecord(event.breadcrumbs, redactBreadcrumbFields);
  forEachRecord(event.spans, redactSpanFields);

  // Session Replay: `replay_event.urls` is every URL the recorded session visited.
  redactUrlList(event, event.urls);

  return event;
}

/** Scrub a breadcrumb as it is recorded — the `beforeBreadcrumb` hook. */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  if (isRecord(breadcrumb)) redactBreadcrumbFields(breadcrumb);
  return breadcrumb;
}

/**
 * Scrub a Session Replay recording frame — the `beforeAddRecordingEvent` hook.
 *
 * Frames arrive as `{ type: 5, data: { tag, payload } }`; the URL sits on
 * `payload.description` for a `performanceSpan` (navigation/resource entries) and on
 * `payload.data.from` / `.to` / `.url` for a `breadcrumb`.
 *
 * ⚠ THIS HOOK IS NOT SUFFICIENT ON ITS OWN, and that is why the client config ALSO refuses
 * to start Replay on a sensitive path. Verified against the SDK, not assumed:
 * `maybeApplyCallback` runs the callback only `if (typeof callback === 'function' &&
 * isCustomEvent(event))`, so it sees custom (type 5) frames ONLY. The rrweb META frame
 * (type 4) carries `data.href` — the full URL — straight past it, unscrubbable by any
 * exposed callback. Exclusion is the only airtight answer; this hook is the second layer.
 */
export function scrubReplayRecordingEvent<T>(frame: T): T {
  // Resolved as one expression rather than four guard-clause `return frame`s: every path
  // returned the identical value, which reads as a function whose result carries
  // information when it does not (SonarCloud S3516). The redaction is the MUTATION; the
  // return exists only because the SDK hook contract hands the frame back.
  const payload = isRecord(frame) && isRecord(frame.data) ? frame.data.payload : undefined;

  if (isRecord(payload)) {
    redactStringAt(payload, 'description');
    redactStringAt(payload, 'message');
    redactUrlKeys(payload.data);
  }

  return frame;
}

/**
 * Does `value` contain a secret that redaction would strip?
 *
 * DERIVED, never a second registry: "sensitive" is defined as "redaction changes it", so
 * this cannot drift from `SENSITIVE_PATH_PREFIXES` the way a hand-copied prefix list would.
 */
export function isSensitiveUrl(value: string): boolean {
  return redactSensitivePath(value) !== value;
}

/**
 * The scrubbing hooks, spread into all three `Sentry.init` calls.
 *
 * `beforeSend` and `beforeSendTransaction` are separate SDK options that happen to want the
 * same treatment — every URL position is scrubbed for both — so they share one function
 * rather than duplicating its body.
 */
export const sentryScrubbingOptions = {
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
} as const;
