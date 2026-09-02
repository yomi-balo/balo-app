/**
 * The user-facing base URL of the web app, resolved SERVER-SIDE from `APP_URL` — the same
 * variable every other user-facing link in apps/api already trusts (notification email
 * templates, the calendar OAuth callback).
 *
 * ⚠ THE ONLY SOURCE OF A `return_url` FOR STRIPE. Never accept a browser-supplied one: a
 * client-controlled value would let a caller choose where Stripe bounces the user after 3DS —
 * an open redirect carrying the platform's own domain as the referrer. Callers pass the path
 * they want; the origin is never theirs to choose.
 */

/**
 * BAL-515 — BLANK IS ABSENT. Railway's shape for an unset variable is the empty string, and `??`
 * is NULLISH: a blank `APP_URL` did NOT trip the old localhost fallback, it produced
 * `return_url: "/billing/top-up"` — a bare relative path Stripe rejects. Two holes, one reader.
 */
function readAppUrl(): string | undefined {
  const raw = process.env.APP_URL;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return raw.trim();
}

/**
 * BAL-515 (security MEDIUM-3) — THE PATH IS PART OF THE URL, SO IT IS PART OF THE GUARD.
 *
 * The docblock above forbids a browser-supplied ORIGIN, but `path` was unvalidated — and a path
 * can move the origin all by itself, which is the exact substitution this function exists to
 * prevent:
 *  · `'//evil.com'`  → `https://app.balo.test//evil.com`, a protocol-relative URL a browser
 *    resolves to `evil.com`;
 *  · `'/\evil.com'`  → the backslash variant browsers normalise to `//`;
 *  · `'@evil.com'`   → `https://app.balo.test@evil.com`, where everything before the `@` is
 *    userinfo and the HOST is `evil.com`;
 *  · `'https://evil.com'` → not even joined; the whole origin is replaced.
 *
 * Every caller today passes a literal (`'/billing/top-up'`), so nothing is broken by closing
 * this. It is closed NOW because the hole opens silently the first time someone threads a
 * request value through — and the value it feeds is a Stripe `return_url` on the money path.
 *
 * Accepted: empty (the bare origin), or ONE leading `/` followed by something that is neither
 * `/` nor `\`. Rejected loudly rather than sanitised — a caller passing something else has a
 * bug, and quietly rewriting it would hide it.
 */
function assertSafePath(path: string): void {
  if (path.length === 0) {
    return;
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw new Error(
      `resolveAppUrl path must be empty or a same-origin path starting with a single "/": received ${JSON.stringify(path)}`
    );
  }
}

/**
 * BAL-515 — an absolute `http(s)` origin, or it is not usable as a Stripe `return_url`.
 *
 * `new URL(value)` with no base throws on anything relative (`app.balo.test`, `//app.balo.test`),
 * and the protocol check rejects a parseable-but-wrong scheme (`javascript:`, `file:`) that a
 * bare parse would happily accept.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function resolveAppUrl(path = ''): string {
  assertSafePath(path);
  const configured = readAppUrl();
  if (configured === undefined) {
    // ⚠ FAIL CLOSED IN PRODUCTION. Both production callers of this function pass its result
    // straight into a Stripe `create({ return_url })` on the money path — the purchase charge
    // (`confirm: true`, so the card is charged server-side) and the mandate SetupIntent. Falling
    // back to localhost there sends a buyer whose card has ALREADY been charged to a dead
    // address, and NOTHING server-side ever learns it happened: it presents as a customer-side
    // problem on a request that returned 200. Throwing turns that silent breakage into a 500 we
    // can see. The localhost convenience survives for local dev only, where it is what makes the
    // flow runnable without an env file.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'APP_URL is not set — it is the Stripe return_url on the money path and has no safe default in production'
      );
    }
    return `http://localhost:3000${path}`;
  }
  const trimmed = configured.endsWith('/') ? configured.slice(0, -1) : configured;
  return `${trimmed}${path}`;
}

/**
 * BAL-515 — boot-time assertion, called from `index.ts` BEFORE `app.listen` so a misconfigured
 * deployment never serves traffic. Mirrors `assertNoShowFloorOverrideUnsetInProduction`
 * (`config/billing-floor.ts`), the codebase's one existing money-motivated boot throw.
 *
 * ⚠ THIS ARGUES PAST THE THREE "NEVER THROW AT BOOT" COMMENTS IN `index.ts`, ON PURPOSE. Those
 * are correct for VENDOR SECRETS whose absence degrades a FEATURE — crash-looping Railway to
 * protect one alert takes down every route. The line the codebase actually draws is MONEY: the
 * billing-floor assert throws precisely because the alternative silently corrupts a money figure
 * rather than degrading a feature. A missing `APP_URL` breaks a checkout AFTER the card is
 * charged, invisibly, so it belongs on the money side of that line. `APP_URL` is already in
 * `.env.example` and `turbo.json`'s `globalEnv`, and is set in production today, so this changes
 * nothing about a correct deployment.
 *
 * Belt AND braces with the in-function throw above: this catches a bad deploy at start-up, that
 * one catches an env unset or blanked at runtime.
 */
export function assertAppUrlSetInProduction(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  const configured = readAppUrl();
  if (configured === undefined) {
    throw new Error(
      'APP_URL must be set in production — it is the Stripe return_url on the money path'
    );
  }
  // BAL-515 — PRESENCE WAS NOT ENOUGH. A set-but-malformed `APP_URL` (`app.balo.test`, a bare
  // host with no scheme; `/app`; a `javascript:` string) passed the presence check and then
  // produced a `return_url` Stripe rejects — turning a config typo into a 400 on the money path
  // at the moment a buyer clicks Pay, rather than a refusal to boot. Shape is asserted HERE,
  // once, at start-up: `resolveAppUrl` deliberately does not re-parse on every call, and the
  // residual is stated plainly — an `APP_URL` REWRITTEN to a malformed value after boot is not
  // caught by this, and surfaces as a Stripe 400 (loud, and before any card is charged) rather
  // than as the silent post-charge dead end the presence check exists for.
  if (!isAbsoluteHttpUrl(configured)) {
    throw new Error(
      `APP_URL must be an absolute http(s) URL in production — it is the Stripe return_url on the money path; received ${JSON.stringify(configured)}`
    );
  }
}
