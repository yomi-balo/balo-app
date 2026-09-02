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

export function resolveAppUrl(path = ''): string {
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
  if (readAppUrl() === undefined) {
    throw new Error(
      'APP_URL must be set in production — it is the Stripe return_url on the money path'
    );
  }
}
