import type { Metadata } from 'next';

/**
 * BAL-504 — the ONE metadata object shared by both marketing-home routes: `(marketing)/page.tsx`
 * (signed-in / session-read-failed) and `(marketing-anon)/anon/page.tsx` (the static anonymous
 * prerender). Both `export const metadata` from this module rather than each declaring its own,
 * so the two can never drift apart — a test asserts their generated `<head>`s match (title,
 * description, canonical, og:image) byte-for-byte.
 *
 * ⚠⚠ NO `robots` FIELD, EVER. Neither route is noindexed: the anon route IS the canonical `/`
 * for an anonymous crawler, not a duplicate of it. `openGraph.title`/`description` are Next's
 * own automatic fallback from `title`/`description` below (merged with the root layout's
 * `openGraph.siteName` / `type` / `locale`) — this module never sets `openGraph` explicitly.
 */
export const MARKETING_HOME_METADATA: Metadata = {
  title: 'Top Salesforce experts, on demand — Balo',
  description:
    'Book a vetted Salesforce expert by the minute. Consultations, projects and packages — ' +
    'one all-in rate, service fee included.',
  alternates: { canonical: '/' },
};
