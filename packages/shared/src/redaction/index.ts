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
 * import the SAME function. A plain substring scan — deliberately no regex, so there is no
 * super-linear/ReDoS surface (SonarCloud S5852) on attacker-controlled URLs.
 *
 * ⚠⚠ FIX ROUND 2 G1 — that "no super-linear surface" claim used to be FALSE for a different
 * reason than regex: {@link redactAllAfterPrefix} (the loop that finds EVERY occurrence of a
 * prefix, added by FIX ROUND 1 F1) re-folded the WHOLE haystack with {@link toAsciiLowerCase}
 * on EVERY iteration, making the case-folded query-param pass O(occurrences × length) —
 * quadratic on a duplicated-param URL, and `apps/web/src/middleware.ts:27` calls this on the
 * bare pathname (`&` is a legal path character) BEFORE any auth check, so this was an
 * unauthenticated Edge CPU-burn vector. Fixed by folding once and keeping the fold in sync by
 * splicing, not recomputing — see {@link redactAllAfterPrefix}'s own docblock for the proof
 * this is sound. ⚠ FIX ROUND 3 R4 — "nearly-linear" overclaimed what the fix actually bought:
 * the per-occurrence FOLD is now O(1) (one splice, no re-scan of the whole haystack), but
 * {@link redactAfterPrefix} still does `value.slice(0, tokenStart) + REDACTED +
 * value.slice(tokenEnd)` per occurrence, which copies the full string every time — so the
 * worst case remains O(occurrences × length), just memcpy-bound instead of
 * `toAsciiLowerCase`-fold-bound. That is why the measured 33.7ms → 0.21ms drop is a large
 * constant-factor win, not a change in asymptotic class. See `redaction.test.ts`'s
 * "FIX ROUND 2 G1" suite (which pins the O(1)-fold-count claim precisely, by call count, not
 * the string-copy behaviour) and this module's git history for the before/after numbers.
 *
 * ⚠ THE SINK REGISTRY — every place a URL leaves the process must route through here:
 *   1. `apps/web/src/middleware.ts`            → the Axiom request line, and `?from=` / `returnTo`
 *      (which is also where the BAL-494 `?t=` switch token is stripped from the request log)
 *   2. `packages/analytics/src/client/client.ts` → PostHog `$current_url` / `$pathname` / `$referrer`,
 *      PLUS (FIX ROUND 1 F4) `$session_entry_url` / `$session_entry_pathname` /
 *      `$session_entry_referrer` and the `$set_once.$initial_current_url` /
 *      `$initial_pathname` / `$initial_referrer` bag — TWO MORE independent PostHog-assembled
 *      properties that also carry `location.href` verbatim and were missed when this registry
 *      note was first written. `client.ts`'s own docblock names the exact posthog-js internals
 *      this was verified against; treat this list as "every NAMED property enumerated so far",
 *      not a static guarantee against a property a future posthog-js version might add.
 *   3. `apps/web/src/lib/observability/sentry-scrub.ts` → Sentry errors, transactions,
 *      breadcrumbs and Session Replay, wired into all three `Sentry.init` runtimes.
 * A fourth sink that captures a URL and does NOT appear on this list is the defect.
 *
 * ⚠ BAL-529 §B — a THIRD query-param registry, {@link STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS}
 * / `PATH_INDEPENDENT_SENSITIVE_QUERY_PARAMS`, joins {@link SENSITIVE_PATH_PREFIXES} and
 * {@link SENSITIVE_QUERY_PARAMS} above. Unlike the other two it is NOT scoped to a path — see
 * its own docblock for why a `pathMarker` list cannot be complete for a Stripe redirect return.
 *
 * ⚠ It matches the PERCENT-ENCODED form of every prefix as well as the literal one, so a
 * sensitive path stashed inside somebody else's query string (`?from=%2Fjoin%2F{token}`)
 * is redacted too. See {@link ENCODED_SENSITIVE_PATH_PREFIXES} for why that is not an
 * optional nicety. FIX ROUND 1 F8 additionally case-folds the query-param registry, matches its
 * `%5f`-encoded param-name form, and (path-independent Stripe pass only) adds `#` as a lead.
 */

import { toAsciiLowerCase } from './ascii-fold';

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

/**
 * ⚠ BAL-529 §F — THE ONE DEFINITION OF "the query params a Stripe redirect return appends".
 * `apps/web/src/lib/stripe/setup-intent-return.ts` reads and deletes exactly these; this module
 * redacts exactly these. A second hand-written copy on either side is the drift this prevents.
 */
export const STRIPE_SETUP_INTENT_PARAM = 'setup_intent';
export const STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM = 'setup_intent_client_secret';
export const STRIPE_REDIRECT_STATUS_PARAM = 'redirect_status';
export const STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS = [
  STRIPE_SETUP_INTENT_PARAM,
  STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM,
  STRIPE_REDIRECT_STATUS_PARAM,
] as const;

/**
 * ⚠ A THIRD REGISTRY: query secrets that are sensitive on EVERY path, unlike
 * {@link SENSITIVE_QUERY_PARAMS}, which scopes `?t=` to one route because `t` is a generic name.
 * Stripe's redirect-return params are not generic — `setup_intent_client_secret` is a live
 * credential (`retrieveSetupIntent`-able from any browser holding the public publishable key)
 * and `setup_intent` is the id that made BAL-526's A1 finding exploitable, wherever they appear.
 *
 * ⚠ AND THE PATH CANNOT BE ENUMERATED. `confirmSetup`/`confirmPayment` return to
 * `origin + pathname` of whichever page hosted the composer — `/settings/billing`, `/redeem`,
 * `/billing/top-up`, the in-call top-up panel — so a `pathMarker` list would be a list that is
 * wrong the moment a new surface renders the composer.
 *
 * `redirect_status` carries no secret and no id; it rides along so the whole return tuple leaves
 * the URL together. `payment_*` are the PaymentIntent twins of the SetupIntent pair —
 * `PayAction.confirmNewCard`'s 3DS return parks them on `/billing/top-up` today.
 */
const PATH_INDEPENDENT_SENSITIVE_QUERY_PARAMS: readonly string[] = [
  ...STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS,
  'payment_intent',
  'payment_intent_client_secret',
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
 * The result of one {@link redactAfterPrefix} scan: the value with (at most) one occurrence
 * redacted, plus where in THAT value the caller should resume scanning to find a LATER
 * occurrence of the same prefix. `nextIndex` advances even when nothing was redacted (a bare
 * prefix with no token segment) — see {@link redactAllAfterPrefix}, the only caller that loops.
 *
 * ⚠⚠ FIX ROUND 2 G1 — `tokenStart`/`tokenEnd` (the `[start, end)` range this scan matched,
 * or would have matched had there been a token — see below) are exposed so
 * {@link redactAllAfterPrefix} can keep ITS OWN case-folded haystack in sync by SPLICING that
 * same range, instead of re-folding the whole string on every iteration. `tokenStart ===
 * tokenEnd` signals the bare-prefix (nothing redacted) case — the caller must not splice then,
 * since nothing was replaced in `value` either.
 */
interface PrefixRedaction {
  readonly value: string;
  readonly nextIndex: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
}

/**
 * Replace the single segment following `prefix` at or after `fromIndex`, or return `null` when
 * `prefix` does not occur there. Linear in `value.length`. THE ONE scan implementation — every
 * caller below, single-shot or looping, goes through this.
 *
 * ⚠ `haystack` IS SEARCHED, `value` IS SLICED. They are the same string for the literal
 * pass; for the encoded / case-folded pass `haystack` is the {@link toAsciiLowerCase} fold of
 * `value`, so `%2F`, `%2f` and `%2F…%2f` all match one lowercase needle while the ORIGINAL
 * casing survives into the output. This is only sound because that fold is length-preserving —
 * see its docblock. Every delimiter is ASCII and unaffected by the fold, so scanning for the
 * token's end in `haystack` and slicing at that index out of `value` agree by construction —
 * which is also what makes `nextIndex` (computed from `haystack` offsets) valid to resume a
 * SUBSEQUENT scan of the REPLACED `value` string: everything before `tokenStart` is byte-for-byte
 * unchanged by the replacement, so an offset into the old string is still correct in the new one.
 */
function redactAfterPrefix(
  value: string,
  haystack: string,
  prefix: string,
  delimiters: string,
  fromIndex = 0
): PrefixRedaction | null {
  const prefixIndex = haystack.indexOf(prefix, fromIndex);
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
  // Prefix present but no actual token segment (e.g. a bare `/shared/proposals/`, or `?t=&`).
  // Nothing to redact, but the cursor still advances past THIS occurrence so a caller looping
  // for a later one does not spin on the same empty match forever.
  if (tokenEnd === tokenStart) return { value, nextIndex: tokenEnd, tokenStart, tokenEnd };
  return {
    value: value.slice(0, tokenStart) + REDACTED + value.slice(tokenEnd),
    nextIndex: tokenStart + REDACTED.length,
    tokenStart,
    tokenEnd,
  };
}

/**
 * The result of {@link redactAllAfterPrefix}: `value` with every occurrence redacted, plus
 * `haystack` kept in sync (see below) so a CALLER threading several `redactAllAfterPrefix`
 * calls over the same growing `value` (`redactSensitiveQueryParams` does exactly this) can
 * carry the fold forward instead of recomputing it for the next call too.
 */
interface AllPrefixRedaction {
  readonly value: string;
  readonly haystack: string;
}

/**
 * ⚠⚠ FIX ROUND 1 F1 (security S2 / review CRITICAL-1) — loop {@link redactAfterPrefix} to a
 * fixpoint against EVERY occurrence of `prefix`, not just the first. A single pass left the
 * SECOND occurrence of a duplicated Stripe param completely unredacted — and on the A2
 * `return_url`-poisoning shape (`stripe-redirect.ts`'s `duplicate_params` reason), Stripe
 * appends the GENUINE pair SECOND, after the attacker's — so the one pass that mattered most
 * redacted the wrong one and let the live secret through.
 *
 * Terminates: each successful redaction inserts `[redacted]`, which contains none of
 * `delimiters`, so it is never re-matched as a fresh occurrence of `prefix`; a bare
 * (tokenless) occurrence still advances `nextIndex` past itself. Either way the cursor moves
 * strictly forward every iteration, so the loop always reaches `haystack.length`.
 *
 * `haystack` is the (optionally case-folded) search copy of `value` — pass `value` itself
 * for a literal, case-sensitive scan, or {@link toAsciiLowerCase}`(value)` for a case-folded
 * one (FIX ROUND 1 F8).
 *
 * ⚠⚠ FIX ROUND 2 G1 (performance — CPU-burn on unauthenticated Edge input) — `haystack` is
 * folded ONCE by the CALLER and passed in, never recomputed here. The previous shape called
 * `haystackOf(result)` — a full re-fold of the WHOLE string via {@link toAsciiLowerCase}'s
 * hand-rolled per-character loop — on EVERY iteration of this loop, making the case-folded
 * pass O(occurrences × length): an attacker-controlled URL with N duplicated Stripe params
 * (reachable pre-auth — `apps/web/src/middleware.ts:27` redacts the bare pathname before any
 * auth check, and `&` is a legal path character) drove this to measured quadratic time.
 *
 * Instead, after every successful match this function keeps `haystack` in sync by SPLICING
 * `REDACTED` into the identical `[tokenStart, tokenEnd)` range that was just replaced in
 * `result` — never by re-folding. This is sound (not merely faster) for exactly two reasons,
 * both properties of {@link toAsciiLowerCase} documented on its own definition:
 *   1. LENGTH-PRESERVING — `toAsciiLowerCase(v).length === v.length` for every `v`, so an
 *      index computed in one string is always a valid index in the other, before AND after a
 *      splice of equal-length text.
 *   2. PER-CODE-UNIT, NO CROSS-CHARACTER STATE — the fold has no lookahead/lookbehind, so
 *      folding a substring and taking the same substring of the fold of the whole string agree.
 *      Concretely: `toAsciiLowerCase(a + b + c) === toAsciiLowerCase(a) + toAsciiLowerCase(b) +
 *      toAsciiLowerCase(c)` for any split. Splicing therefore commutes with folding.
 * `REDACTED` (`[redacted]`) is itself already all-lowercase ASCII — `toAsciiLowerCase(REDACTED)
 * === REDACTED` — so the spliced-in text needs no folding of its own before being spliced into
 * `haystack`. Together: `haystack` after the splice equals `toAsciiLowerCase(result)` after the
 * SAME splice was applied to `result` to produce it — exactly what a re-fold would have
 * produced, without ever walking the whole string again.
 *
 * ⚠ This soundness argument is INDEPENDENT of what `prefix` looks like — plain ASCII or a
 * percent-encoded needle (`%5f`, `%2f`, `%252f`, …) — because {@link toAsciiLowerCase} treats
 * every code unit identically regardless of what it is part of; there is no special-casing of
 * `%` anywhere in the fold. See its own docblock for the explicit statement of this.
 *
 * ⚠ The splice is sound only for a `haystack` that is either the identity or
 * {@link toAsciiLowerCase} of `value` — the only two shapes any caller in this file ever
 * passes (`redactAfterPrefix`/`redactAllAfterPrefix` are module-private, not exported). A
 * hypothetical THIRD fold that is not length-preserving, or that reads neighbouring
 * characters, would desynchronise silently under this splice.
 */
function redactAllAfterPrefix(
  value: string,
  haystack: string,
  prefix: string,
  delimiters: string
): AllPrefixRedaction {
  let result = value;
  let currentHaystack = haystack;
  let fromIndex = 0;
  for (;;) {
    const match = redactAfterPrefix(result, currentHaystack, prefix, delimiters, fromIndex);
    if (match === null) return { value: result, haystack: currentHaystack };
    result = match.value;
    fromIndex = match.nextIndex;
    if (match.tokenEnd > match.tokenStart) {
      currentHaystack =
        currentHaystack.slice(0, match.tokenStart) +
        REDACTED +
        currentHaystack.slice(match.tokenEnd);
    }
  }
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
  return redacted?.value ?? value;
}

/**
 * A parameter can be first in the query string (`?t=`) or not (`&t=`); its position is not
 * ours to fix, since a redirect chain or an instrumentation rewrite can reorder it.
 */
const QUERY_PARAM_LEADS: readonly string[] = ['?', '&'];

/**
 * ⚠ FIX ROUND 1 F8 (security S6) — the path-independent Stripe/PaymentIntent pass gets a THIRD
 * lead, `#`. `$current_url` (the PostHog sink this registry exists for) includes the fragment,
 * and nothing stops a future SPA-style hash route from carrying these params after a `#`. The
 * `pathMarker`-scoped {@link SENSITIVE_QUERY_PARAMS} pass below deliberately does NOT get this
 * — `?t=` is a common, innocuous name and widening its match surface to fragments as well as
 * queries is not this fix's job.
 */
const PATH_INDEPENDENT_QUERY_PARAM_LEADS: readonly string[] = ['?', '&', '#'];

/**
 * ⚠ FIX ROUND 1 F8 (security S5) — the percent-encoded-underscore form of a Stripe param name
 * (`setup_intent` → `setup%5fintent`). Every param in {@link PATH_INDEPENDENT_SENSITIVE_QUERY_PARAMS}
 * contains at least one `_`, and `URLSearchParams` DECODES param NAMES before
 * `readSetupIntentReturnParams` ever sees them — so `?setup%5Fintent=` is read as a genuine
 * `setup_intent` by that reader while being INVISIBLE to a literal-underscore search here. Only
 * the depth-1 form: unlike {@link ENCODED_SLASH_FORMS}, Stripe itself never emits an encoded
 * param NAME (only `SENSITIVE_PATH_PREFIXES`' path segments travel encoded, inside someone
 * else's query value), so this is defence in depth against a hand-crafted link, not a shape any
 * genuine return produces — one encoding depth is enough to close the gap the finding named.
 *
 * ⚠ FIX ROUND 2 G5 — THIS ONLY COVERS THE ALL-OR-NOTHING FORMS. `replaceAll` turns EVERY `_` in
 * `param` into `%5f`, so this needle matches only the fully-literal name (searched separately,
 * above) and the fully-encoded name — never a MIXED form. `setup_intent_client_secret` has three
 * underscores; `?setup%5Fintent_client_secret=` (just the first one encoded) is read as the
 * genuine param by `URLSearchParams`/`readSetupIntentReturnParams` (which decode per-occurrence,
 * not per-name) exactly like the fully-encoded form is, but is INVISIBLE to both needles this
 * function and the literal search generate — the same reader/redactor asymmetry F8 named as its
 * own rationale, not fully closed by it. Matching every mixed form exactly would need per-`_`
 * combinatorial needles (2^(underscore count) − 2 extra variants for a 3-underscore name); not
 * done here. Defence-in-depth against a hand-crafted link either way (see above) — stated so the
 * gap is visible, not implied covered.
 */
function encodedUnderscoreForm(param: string): string {
  return param.replaceAll('_', '%5f');
}

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
  // BAL-529 §B — the path-independent Stripe/PaymentIntent pass. Runs unconditionally (no
  // `pathMarker` gate — see PATH_INDEPENDENT_SENSITIVE_QUERY_PARAMS's docblock for why one
  // cannot be complete here), reusing the exact same scan primitives as the scoped pass below
  // so there is still only one implementation of "find and replace a query value".
  //
  // FIX ROUND 1 F1 (security S2) — `redactAllAfterPrefix`, not a single `redactAfterPrefix`
  // call, so a DUPLICATED param (the A2 return_url-poisoning shape) is redacted at every
  // occurrence, not just the first. FIX ROUND 1 F8 (security S5) — the haystack is
  // {@link toAsciiLowerCase}-folded, so `?SETUP_INTENT=` matches the same needle as
  // `?setup_intent=`; a second inner pass repeats the search for the `%5f`-encoded param name.
  //
  // FIX ROUND 2 G1 (SECONDARY) — `folded` is computed ONCE for this whole pass and threaded
  // through every iteration of the double loop below (5 params × 3 leads × 2 encoded forms =
  // up to 30 `redactAllAfterPrefix` calls), rather than each call folding `result` again from
  // scratch. Before this, a URL with ZERO Stripe params still paid 30 full-string folds per
  // `redactSensitivePath` call — pure overhead on origin/main's behalf, since origin/main did
  // none. `redactAllAfterPrefix` already keeps `folded` in sync via splicing (see its own
  // docblock), so re-assigning it from each call's returned `haystack` is free — no extra fold
  // is ever performed here, whether or not that call actually redacted anything.
  let folded = toAsciiLowerCase(result);
  for (const param of PATH_INDEPENDENT_SENSITIVE_QUERY_PARAMS) {
    for (const lead of PATH_INDEPENDENT_QUERY_PARAM_LEADS) {
      let pass = redactAllAfterPrefix(result, folded, `${lead}${param}=`, QUERY_VALUE_DELIMITERS);
      result = pass.value;
      folded = pass.haystack;
      pass = redactAllAfterPrefix(
        result,
        folded,
        `${lead}${encodedUnderscoreForm(param)}=`,
        QUERY_VALUE_DELIMITERS
      );
      result = pass.value;
      folded = pass.haystack;
    }
  }
  for (const { pathMarker, param } of SENSITIVE_QUERY_PARAMS) {
    if (!result.includes(pathMarker)) continue;
    for (const lead of QUERY_PARAM_LEADS) {
      // FIX ROUND 1 F1 (security S2) — same duplicate-occurrence fix; this scoped pass has the
      // identical shape (F1's finding named it explicitly). No case-fold / %5f / `#` lead here —
      // F8 scopes those to the path-independent Stripe pass only (see the leads constant above),
      // so the haystack here is the identity, not the folded copy threaded above.
      result = redactAllAfterPrefix(
        result,
        result,
        `${lead}${param}=`,
        QUERY_VALUE_DELIMITERS
      ).value;
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
      return prefix === JOIN_TOKEN_PREFIX
        ? redactGuestRecapMeetingId(redacted.value)
        : redacted.value;
    }
  }
  // Every encoded form begins `%`; skipping the fold when there is none keeps the common
  // case (an ordinary pathname) at a single scan with no allocation.
  if (!value.includes('%')) return value;

  const folded = toAsciiLowerCase(value);
  for (const prefix of ENCODED_SENSITIVE_PATH_PREFIXES) {
    const redacted = redactAfterPrefix(value, folded, prefix, ENCODED_TOKEN_DELIMITERS);
    if (redacted !== null) return redacted.value;
  }
  return value;
}
