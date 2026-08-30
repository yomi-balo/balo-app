import 'server-only';

/**
 * BAL-493 §12.1 — the site origin used for `metadataBase` (root `layout.tsx`) so that OG/
 * Twitter image and canonical URLs resolve to an absolute URL instead of silently resolving
 * relative to whatever host happens to be serving the page.
 *
 * ⚠⚠ **`import 'server-only'` IS LOAD-BEARING, NOT DECORATION.** `APP_URL` has no
 * `NEXT_PUBLIC_` prefix, so in a client bundle Next inlines it as `undefined` and this would
 * silently degrade to the production fallback — mirrors the identical hazard already
 * documented on `apps/web/src/lib/meetings/join-link.ts`, which this file follows closely.
 * `metadataBase` is read only by the root Server Component layout, so this never needs to run
 * on the client.
 *
 * ⚠ Falls back to `NEXT_PUBLIC_APP_URL` before the hardcoded default, matching
 * `join-link.ts`'s precedence exactly, so a local checkout that only set the public variable
 * (the historical default in `apps/web/.env.example`) still resolves a real origin rather than
 * silently falling through to `https://balo.expert` in development.
 */
const DEFAULT_SITE_ORIGIN = 'https://balo.expert';

/**
 * Drop trailing slashes.
 *
 * ⚠ A LINEAR SCAN, NOT `/\/+$/`. That pattern is a quantifier with a rejecting suffix, which
 * SonarCloud's S5852 (super-linear regex) flags as quadratic — the repo's established escape
 * hatch (`join-link.ts`'s `withoutTrailingSlash`, `_source-scan.ts`) is exactly this: a
 * non-regex scan, with no pattern engine behind it.
 */
function withoutTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

/**
 * Resolve the absolute site origin (no trailing slash), e.g. `https://balo.expert`.
 * Order: `APP_URL` (preferred, server-only-safe) → `NEXT_PUBLIC_APP_URL` (dev convenience,
 * inlined at build time) → the hardcoded production default.
 */
export function resolveSiteOrigin(): string {
  const base = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_SITE_ORIGIN;
  return withoutTrailingSlash(base);
}
