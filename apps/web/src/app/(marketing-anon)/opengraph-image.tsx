export { default, alt, size, contentType } from '../(marketing)/opengraph-image';

/**
 * BAL-504 — re-exports `(marketing)/opengraph-image.tsx` verbatim, so the anon and signed-in
 * homes serve byte-identical OG images from ONE source. Placed at the ROUTE-GROUP level (not
 * under `anon/`) so the generated URL is `/opengraph-image-<hash>`, matching `(marketing)`'s
 * convention — under `anon/` it would be `/anon/opengraph-image`, which is outside
 * `PUBLIC_PREFIXES` and would be redirected to `/login` by the anon-home gate.
 */
