/**
 * Secret-in-URL redaction (BAL-386, extended by BAL-390, BAL-408 and BAL-494). Some routes
 * carry a high-entropy secret in the URL path itself — the email-bound magic-link token
 * behind `/shared/proposals/{token}`, the review-invite token behind
 * `/review/{token}`, and the guest join token behind
 * `/join/{token}` — and one carries it in a QUERY PARAMETER
 * ({@link SENSITIVE_QUERY_PARAMS}). Platform-wide instrumentation that captures the URL
 * verbatim (Edge middleware request logging → Axiom; PostHog client pageview
 * autocapture → third party) would otherwise defeat the "raw token is never logged"
 * invariant.
 *
 * {@link redactSensitivePath} is the single, pure, dependency-free implementation
 * shared by ALL sinks. It is client- and Edge-safe (no Node/browser globals, no
 * `server-only`), so the web middleware, the analytics client and the Sentry scrubbers
 * import the SAME function. Linear-time (a plain substring scan — deliberately no regex,
 * so there is no super-linear/ReDoS surface on attacker-controlled URLs).
 *
 * ⚠ THE SINK REGISTRY — every place a URL leaves the process must route through here:
 *   1. `apps/web/src/middleware.ts`            → the Axiom request line, and `?from=` / `returnTo`
 *      (which is also where the BAL-494 `?t=` switch token is stripped from the request log)
 *   2. `packages/analytics/src/client/client.ts` → PostHog `$current_url` / `$pathname` / `$referrer`
 *   3. `apps/web/src/lib/observability/sentry-scrub.ts` → Sentry errors, transactions,
 *      breadcrumbs and Session Replay, wired into all three `Sentry.init` runtimes.
 * A fourth sink that captures a URL and does NOT appear on this list is the defect.
 *
 * ⚠ It matches the PERCENT-ENCODED form of every prefix as well as the literal one, so a
 * sensitive path stashed inside somebody else's query string (`?from=%2Fjoin%2F{token}`)
 * is redacted too. See {@link ENCODED_SENSITIVE_PATH_PREFIXES} for why that is not an
 * optional nicety.
 */

/**
 * ⚠⚠ BAL-439 fix-round-1 / MUST-8 — NAMED, rather than inlined as a fourth literal, so
 * {@link redactGuestRecapMeetingId} below can identify "the `/join/` prefix matched" without a
 * second hand-written `'/join/'` string to drift out of sync with the array entry.
 */
const JOIN_TOKEN_PREFIX = '/join/';

/**
 * Path prefixes whose FOLLOWING segment is a secret and must never be logged.
 *
 * ⚠ PAIRED with `PUBLIC_PREFIXES` in `apps/web/src/lib/auth/route-config.ts`: a
 * token-in-URL route is by definition reachable without a session, so every entry
 * here is also a public prefix there. Adding one registry without the other is the
 * defect. `route-config.test.ts` asserts the containment.
 */
export const SENSITIVE_PATH_PREFIXES: readonly string[] = [
  // BAL-386 — the email-bound magic-link proposal view.
  '/shared/proposals/',
  // BAL-390 — the star-rating landing, `/review/{token}?r={1..5}`. Only the token
  // SEGMENT is replaced, so the `?r=3` prefill survives redaction — which is what
  // keeps the emailed-star funnel legible without ever logging the token.
  '/review/',
  // ⚠⚠ BAL-132 — THE ANONYMOUS LOBBY, `/join/m/{meetingId}`. **IT MUST PRECEDE `/join/`
  // IN THIS ARRAY** — {@link redactSensitivePath} returns on the FIRST prefix that
  // matches, and `/join/` matches `/join/m/{id}` too, replacing the literal segment `m`
  // and producing `/join/[redacted]/{id}` — i.e. the id sails through untouched. That is
  // exactly what shipped before this entry existed, while a docblock claimed the route
  // was "REDACTION-COVERED FOR FREE … verified, not assumed". Order is the fix; a test
  // pins it.
  //
  // ⚠ WHAT IS BEING PROTECTED HERE IS **NOT A CREDENTIAL** — and that difference is worth
  // stating, because it is the only entry in this list that is not one. A meeting id
  // admits nobody: the Daily room is `privacy: 'private'`, knocking is rate-limited and
  // queue-capped, and entry needs an explicit host admit. It is listed because the whole
  // feature is built on treating "a meeting exists at this uuid" as non-disclosable to an
  // anonymous visitor, and this URL is the one place that fact leaves the perimeter from
  // an ANONYMOUS BROWSER on a PUBLIC page — into PostHog's `$current_url` / `$pathname`,
  // i.e. a third-party processor, for a meeting the visitor may merely have guessed.
  //
  // ⚠ IT COSTS NOTHING IN DEBUGGABILITY, which is why it is redaction rather than a
  // docblock correction. `meetingId` is still logged DELIBERATELY as a structured field by
  // `claim-lobby-place.ts`, `poll-guest-admission.ts` and every `apps/api` join log line —
  // different sink, different audience, unchanged. Only the URL-shaped copy is redacted.
  //
  // ⚠ NO FALSE MATCH ON `/join/{token}`: guest tokens are base64url and contain no `/`, so
  // the literal eight characters `/join/m/` cannot occur inside one.
  '/join/m/',
  // BAL-408 / ADR-1044 — the guest join landing, `/join/{token}`. The token is the
  // ONLY credential a guest has for a meeting they were invited to, and it is
  // deliberately NOT single-use (desktop → phone → rejoin after a network drop), so
  // one leaked line in Axiom or one `$referrer` in PostHog stays replayable for the
  // whole 7-day window. Redaction here, `referrer: 'no-referrer'` on the layout.
  JOIN_TOKEN_PREFIX,
];

const REDACTED = '[redacted]';

/**
 * Fold ONLY `A`–`Z` to lower case, leaving every other code unit — including all non-ASCII —
 * byte-for-byte identical.
 *
 * ⚠ THE POINT IS THE LENGTH INVARIANT, not the casing. `String.prototype.toLowerCase` is
 * locale- and Unicode-aware and can CHANGE THE LENGTH of a string (`'İ'` folds to two code
 * units), which would silently desynchronise an index found in the folded copy from the
 * original it is sliced out of — turning a redaction into a corruption. A strict A–Z fold is
 * one-to-one on code units, so `toAsciiLowerCase(v).length === v.length` always holds and an
 * index is interchangeable between the two.
 *
 * Deliberately no regex, matching the rest of this module: attacker-controlled URLs must not
 * meet a pattern with a super-linear worst case (SonarCloud S5852).
 */
const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';

function toAsciiLowerCase(value: string): string {
  let folded = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    // Table lookup rather than arithmetic on char codes. SonarCloud pushes `charCodeAt` →
    // `codePointAt` (S7728) as a blanket ES2015 preference, but that swap would be WRONG
    // here and silently so: this loop walks CODE UNITS on purpose, and `codePointAt` at a
    // high surrogate returns the combined code point, breaking the one-to-one index
    // correspondence that `toAsciiLowerCase(v).length === v.length` depends on. Indexing a
    // 26-char table sidesteps the whole argument — no char codes, same guarantee.
    const upperIndex = ASCII_UPPER.indexOf(char);
    folded += upperIndex === -1 ? char : ASCII_LOWER.charAt(upperIndex);
  }
  return folded;
}

/**
 * ⚠ THE PERCENT-ENCODED FORMS — the "encode-then-miss" trap, closed once for all prefixes.
 *
 * A sensitive path does not only travel as a path. The moment it is stashed as a QUERY
 * VALUE the slashes are percent-encoded, and a plain `indexOf('/join/')` misses it
 * completely — the redaction silently no-ops and the raw token flows on to Axiom, to a
 * PostHog property, and into the address bar of whatever page consumed it.
 *
 * The live instance this was found on: the fail-closed onboarding gate in
 * `apps/web/src/middleware.ts` does `url.searchParams.set('from', pathname)` for an
 * authenticated-but-not-onboarded visitor, producing
 * `/onboarding?forced=1&from=%2Fjoin%2F{raw token}`. That affects `/join/` (BAL-408),
 * `/review/` (BAL-390) and `/shared/proposals/` (BAL-386) identically.
 *
 * ⚠ DERIVED FROM `SENSITIVE_PATH_PREFIXES`, NEVER HAND-LISTED. A hand-written encoded list
 * is a second registry that silently falls out of date the next time a prefix is added —
 * which is exactly the failure mode this constant exists to prevent.
 *
 * ⚠ MATCHED CASE-INSENSITIVELY AND AT TWO ENCODING DEPTHS, because a two-literal list
 * (`%2F` and `%2f`) is defeated by inputs no encoder has to promise not to produce:
 *   - MIXED case within one prefix — `%2Fjoin%2f` matches neither all-upper nor all-lower.
 *   - DOUBLE encoding — a value round-tripped through two encoders arrives as
 *     `%252Fjoin%252F`, where the literal `%2F` never appears at all.
 * Neither is reachable through a shipped Balo flow today (`redirectToOnboarding` redacts
 * the raw pathname BEFORE `URLSearchParams` encodes it, so Balo's own encoder is never the
 * one that matters), so this is defence in depth against a future or third-party producer —
 * which is exactly the class of caller that will not be reviewed against this file.
 *
 * The case-insensitivity is bought with {@link toAsciiLowerCase}, NOT
 * `String.prototype.toLowerCase`: the latter is not length-preserving for every Unicode
 * input (`'İ'.toLowerCase()` is two code units), so indices taken from a `toLowerCase()`
 * copy cannot be sliced back out of the original safely. Restricting the fold to A–Z keeps
 * the copy index-for-index aligned with `value`, which is what makes the slice sound.
 */
const ENCODED_SLASH_FORMS: readonly string[] = [
  // Depth 1 — one pass through `encodeURIComponent` / `URLSearchParams`.
  '%2f',
  // Depth 2 — the same value encoded twice (`%` itself became `%25`).
  '%252f',
];

const ENCODED_SENSITIVE_PATH_PREFIXES: readonly string[] = SENSITIVE_PATH_PREFIXES.flatMap(
  (prefix) => ENCODED_SLASH_FORMS.map((slash) => toAsciiLowerCase(prefix).replaceAll('/', slash))
);

/**
 * ⚠ A SECOND, SEPARATE REGISTRY: secrets carried as a QUERY VALUE, scoped to the path that
 * carries them (BAL-494 security fix round 2).
 *
 * ⚠ WHY NOT AN ENTRY IN `SENSITIVE_PATH_PREFIXES`. Two reasons, both structural:
 *   1. SHAPE — that list redacts the path SEGMENT after a prefix. `?t=<sealed>` is not a
 *      segment; a `/api/auth/switch-workspace` entry there would match nothing.
 *   2. THE PAIRING INVARIANT — every entry in that list is also a PUBLIC prefix in
 *      `apps/web/src/lib/auth/route-config.ts`, and `route-config.test.ts` asserts the
 *      containment. `/api/auth/switch-workspace` REQUIRES a session; adding it there would
 *      either break that test or, worse, be "fixed" by making an authenticated route public.
 *
 * ⚠ WHAT IS BEING PROTECTED. The BAL-494 deep-link auto-switch redirect is
 * `/api/auth/switch-workspace?t=<sealed token>&returnTo=…`. The seal is unforgeable and
 * TTL-bounded (120s effective — see `switch-token.ts`), so this is a short-lived credential
 * rather than a 7-day one, but it is still a credential and it still reaches Sentry
 * verbatim: an unhandled throw inside the route ships `event.request.url` AND
 * `contexts.nextjs.request_path`, neither of which `sendDefaultPii: false` gates. It also
 * reaches the Edge request log. `param` is matched only when `pathMarker` is present, so no
 * other route's `?t=` is touched.
 */
const SENSITIVE_QUERY_PARAMS: readonly { readonly pathMarker: string; readonly param: string }[] = [
  { pathMarker: '/api/auth/switch-workspace', param: 't' },
];

/** A raw path secret runs until the next path/query/fragment delimiter, or the end. */
const RAW_TOKEN_DELIMITERS = '/?#';

/**
 * A query VALUE ends at the next parameter (`&`) or at the fragment (`#`). Deliberately does
 * NOT stop at `/` or `%`: a sealed iron token is base64url-ish but `returnTo`-style values
 * legitimately contain both, and over-consuming a value we have already decided is secret is
 * harmless while under-consuming would leak its tail.
 */
const QUERY_VALUE_DELIMITERS = '&#';

/**
 * An ENCODED secret additionally ends at `&` (the next query parameter) and at `%` (the
 * start of an encoded delimiter — `%2F`, `%3F`, `%23`). Every token surface on the
 * platform is `base64url` (`[A-Za-z0-9_-]`), so neither character can be part of a
 * secret; stopping at them can only ever under-consume, never leak.
 */
const ENCODED_TOKEN_DELIMITERS = '/?#&%';

/**
 * Replace the single segment following `prefix`, or return `null` when `prefix` is
 * absent / present with no segment after it. Linear in `value.length`.
 *
 * ⚠ `haystack` IS SEARCHED, `value` IS SLICED. They are the same string for the literal
 * pass; for the encoded pass `haystack` is the {@link toAsciiLowerCase} fold of `value`, so
 * `%2F`, `%2f` and `%2F…%2f` all match one lowercase needle while the ORIGINAL casing
 * survives into the output. This is only sound because that fold is length-preserving — see
 * its docblock. Every delimiter is ASCII and unaffected by the fold, so scanning for the
 * token's end in `haystack` and slicing at that index out of `value` agree by construction.
 */
function redactAfterPrefix(
  value: string,
  haystack: string,
  prefix: string,
  delimiters: string
): string | null {
  const prefixIndex = haystack.indexOf(prefix);
  if (prefixIndex === -1) return null;

  const tokenStart = prefixIndex + prefix.length;
  let tokenEnd = haystack.length;
  for (let i = tokenStart; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (ch !== undefined && delimiters.includes(ch)) {
      tokenEnd = i;
      break;
    }
  }
  // Prefix present but no actual token segment (e.g. a bare `/shared/proposals/`).
  if (tokenEnd === tokenStart) return value;
  return value.slice(0, tokenStart) + REDACTED + value.slice(tokenEnd);
}

/**
 * ⚠⚠ BAL-439 fix-round-1 / MUST-8 (security F3) — `/join/{token}/recap/{meetingId}` is a
 * SECOND non-disclosable id chained after the token. `redactAfterPrefix` only ever replaces
 * the ONE segment immediately following a prefix, so the `/join/` entry alone turns
 * `/join/{token}/recap/{meetingId}` into `/join/[redacted]/recap/{meetingId}` — the
 * credential is protected but the meeting UUID sails through untouched. The `/join/m/` entry
 * above exists for exactly this reason: "a meeting exists at this uuid" is treated as
 * non-disclosable to a third-party processor, and this route reintroduces that same shape.
 *
 * Chained onto the RESULT of the `/join/` redaction (never applied standalone, and never
 * reachable through any other prefix) — so a `/join/{token}` with no `/recap/` suffix, or a
 * `/join/{token}/lobby` sub-route, is untouched, matching the existing pinned behaviour for
 * a trailing segment that is not `/recap/`.
 */
const RECAP_MEETING_ID_PREFIX = `${REDACTED}/recap/`;

function redactGuestRecapMeetingId(value: string): string {
  const redacted = redactAfterPrefix(value, value, RECAP_MEETING_ID_PREFIX, RAW_TOKEN_DELIMITERS);
  return redacted ?? value;
}

/**
 * A parameter can be first in the query string (`?t=`) or not (`&t=`); its position is not
 * ours to fix, since a redirect chain or an instrumentation rewrite can reorder it.
 */
const QUERY_PARAM_LEADS: readonly string[] = ['?', '&'];

/**
 * The {@link SENSITIVE_QUERY_PARAMS} pass. Runs BEFORE the path pass and independently of it:
 * the path pass returns on its FIRST match, so folding this in as another prefix entry would
 * make whichever matched first suppress the other.
 *
 * Idempotent, like the path pass — `[redacted]` contains no delimiter, so a second run
 * replaces it with itself.
 */
function redactSensitiveQueryParams(value: string): string {
  let result = value;
  for (const { pathMarker, param } of SENSITIVE_QUERY_PARAMS) {
    if (!result.includes(pathMarker)) continue;
    for (const lead of QUERY_PARAM_LEADS) {
      const redacted = redactAfterPrefix(
        result,
        result,
        `${lead}${param}=`,
        QUERY_VALUE_DELIMITERS
      );
      if (redacted !== null) result = redacted;
    }
  }
  return result;
}

/**
 * Redact the secret segment that follows a known sensitive prefix, anywhere within
 * `value`. Accepts a bare pathname (`/shared/proposals/abc`) OR a full URL
 * (`https://host/shared/proposals/abc?x=1`) OR a referrer OR a URL that carries a
 * sensitive path PERCENT-ENCODED inside one of its own query values — the prefix is
 * located by substring so all four work. Only the single segment after the prefix is
 * replaced; any trailing path (`/more`), query (`?x`), or fragment (`#y`) is preserved.
 *
 *   `/shared/proposals/abc123`             → `/shared/proposals/[redacted]`
 *   `/shared/proposals/abc123?x=1`         → `/shared/proposals/[redacted]?x=1`
 *   `/onboarding?from=%2Fjoin%2Fabc123`    → `/onboarding?from=%2Fjoin%2F[redacted]`
 *   `/onboarding?from=%252Fjoin%252Fabc`   → `/onboarding?from=%252Fjoin%252F[redacted]`
 *   `/shared/proposals/` (no token)        → unchanged
 *   `/dashboard`                           → unchanged
 *   `/join/tok/recap/a0000000-…`           → `/join/[redacted]/recap/[redacted]` (MUST-8)
 *
 * ⚠ IDEMPOTENT — feeding an already-redacted value back through is a no-op
 * (`[redacted]` contains no delimiter, so it is re-matched as the token and replaced by
 * itself). That matters because the Sentry scrubbers run this over fields that other
 * processors may already have passed through.
 *
 * The literal pass runs FIRST and wins: a value carrying both forms
 * (`/join/raw?from=%2Freview%2Fenc`) redacts the one that is actually being navigated to.
 */
export function redactSensitivePath(value: string): string {
  return redactSensitivePathPrefixes(redactSensitiveQueryParams(value));
}

function redactSensitivePathPrefixes(value: string): string {
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    const redacted = redactAfterPrefix(value, value, prefix, RAW_TOKEN_DELIMITERS);
    if (redacted !== null) {
      return prefix === JOIN_TOKEN_PREFIX ? redactGuestRecapMeetingId(redacted) : redacted;
    }
  }
  // Every encoded form begins `%`; skipping the fold when there is none keeps the common
  // case (an ordinary pathname) at a single scan with no allocation.
  if (!value.includes('%')) return value;

  const folded = toAsciiLowerCase(value);
  for (const prefix of ENCODED_SENSITIVE_PATH_PREFIXES) {
    const redacted = redactAfterPrefix(value, folded, prefix, ENCODED_TOKEN_DELIMITERS);
    if (redacted !== null) return redacted;
  }
  return value;
}
