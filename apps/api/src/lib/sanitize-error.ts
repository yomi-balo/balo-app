/**
 * BAL-473 FIX ROUND 1 (F4) — a vendor error's message, SANITIZED for the two sinks the
 * recording jobs write to: `meeting_recordings.failure_reason` (a `text` column, read by
 * ops/runbooks) and the structured logger (Axiom).
 *
 * ⚠⚠ WHY THIS EXISTS: `@mux/mux-node`'s `APIError` builds its `.message` as
 * `` `${status} ${JSON.stringify(errorBody)}` `` whenever the body has no top-level `message`
 * field, and Mux's `invalid_parameters` bodies ECHO THE OFFENDING INPUT — for
 * `assets.create` on this feature, that input is the live, short-lived Daily signed access
 * link. A bare `error.message` therefore writes that link into a DB column and into a
 * third-party log store. `packages/analytics/src/events/recording.ts` already treats this as
 * settled doctrine ("a Daily error body is arbitrary response text and can contain a signed
 * URL, and PostHog is a third party" — hence its CLOSED `RecordingFailureReason` union); this
 * module is the same doctrine applied to the two sinks that union's docblock says do NOT get
 * it: `failure_reason` and `log.error`.
 *
 * Two layers:
 *   1. A recognised `Mux.APIError` maps to a CLOSED shape — `${status} ${type}` — which by
 *      construction cannot carry the raw body, however that body is shaped.
 *   2. Anything else (a Daily `DailyApiError`, a network fault, a plain `Error`) falls back to
 *      `error.message`, with any URL-shaped substring redacted as a backstop. Today's
 *      `DailyApiError.message` is a fixed template (`Daily API error: ${method} ${path}
 *      responded ${status}`) that never echoes a body, so this branch is not KNOWN to leak
 *      anything today — the redaction exists so a future change to that message (or a vendor
 *      error this module has not seen yet) cannot reopen the leak silently.
 */
import Mux, { type APIError as MuxAPIError } from '@mux/mux-node';

/** Anything `http(s)://`-shaped, greedy up to the next whitespace. */
const URL_PATTERN = /https?:\/\/\S+/g;

function redactUrls(message: string): string {
  return message.replace(URL_PATTERN, '[redacted-url]');
}

/** The Mux error body's `type` field, when present and a string. Never the rest of the body. */
function muxErrorType(error: MuxAPIError): string {
  const body = error.error as { type?: unknown } | null | undefined;
  return typeof body?.type === 'string' && body.type.length > 0 ? body.type : 'error';
}

/**
 * A vendor error's message, safe to write to `meeting_recordings.failure_reason` and to
 * `log.error`. NEVER a raw vendor response body.
 */
export function sanitizedErrorMessage(error: unknown): string {
  if (error instanceof Mux.APIError) {
    return `${error.status ?? 'unknown'} ${muxErrorType(error)}`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  return redactUrls(raw);
}
