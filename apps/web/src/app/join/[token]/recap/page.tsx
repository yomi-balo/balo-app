import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { hashedClientIp } from '@/lib/magic-link';
import { trackServerAndFlush, GUEST_SERVER_EVENTS } from '@/lib/analytics/server';
import { LinkNotActive } from '../link-not-active';
import { loadGuestRecapIndex } from './_lib/load-guest-recap-index';
import { GuestRecapIndexCard } from './_components/guest-recap-index-card';

// `node:crypto` (token hashing, via the loader) + Drizzle need Node, not Edge.
export const runtime = 'nodejs';
// Per-token, gate-resolved content — never statically cached.
export const dynamic = 'force-dynamic';

// Public magic-link page — deliberately NOT indexed, and a NEUTRAL title matching the
// invitation landing's own posture (never names the company, the agency or the expert).
export const metadata: Metadata = {
  title: 'Your recaps — Balo',
  robots: { index: false, follow: false },
};

interface GuestRecapIndexPageProps {
  /** ⚠ Next 16: this is a Promise and MUST be awaited. */
  readonly params: Promise<{ token: string }>;
}

/**
 * ⚠⚠ ZOD FIRST, BEFORE ANYTHING TOUCHES A REPOSITORY — the same reason `[meetingId]/page.tsx`
 * validates first: a malformed param must never reach a repository read that could throw a
 * visibly different error, i.e. an oracle.
 */
const paramsSchema = z.object({
  token: z.string().min(20).max(200),
});

/**
 * BAL-492 — the guest recap INDEX. `app/join/[token]/recap` (no `meetingId`): the token
 * authenticates, and — unlike the per-meeting page — this route lists every `ended` meeting the
 * token's grant admits, each row linking to the already-shipped
 * `/join/[token]/recap/[meetingId]` page.
 *
 * ⚠⚠ THE AUTHORISATION DOES NOT MOVE. This page (via {@link loadGuestRecapIndex}) never decides
 * "who may read this meeting" a second time — every row it renders already passed
 * `resolveGuestRecapAccess`, the SAME per-meeting gate `[meetingId]/page.tsx` itself runs.
 *
 * ⚠⚠ D2 — A `meeting`-SCOPE GUEST IS REDIRECTED, NOT SHOWN `LinkNotActive` AND NOT SHOWN A
 * ONE-ROW INDEX. The loader returns `{ kind: 'redirect', href }` for that grant, and `redirect()`
 * is called HERE, OUTSIDE ANY `try` — Next implements it by throwing `NEXT_REDIRECT`, and the
 * loader's own `try { … } catch { return null }` collapse would otherwise swallow it and render
 * `LinkNotActive` instead. See `load-guest-recap-index.ts`'s docblock for the full account.
 *
 * ⚠⚠ ONE IDENTICAL `LinkNotActive` FOR EVERY DENIAL, exactly like `[meetingId]/page.tsx`: a bad
 * token, a revoked guest, a pending admission, a declined request-grain relationship, a
 * malformed param and a throttle all collapse to the SAME propless card. Never `notFound()`.
 *
 * ⚠ `GUEST_RECAP_INDEX_VIEWED` fires on a SUCCESSFUL INDEX RENDER ONLY — never on the redirect,
 * never on a denial. A denial event keyed on a crafted token would itself be an enumeration
 * signal, the same reasoning `GUEST_RECAP_VIEWED` already states.
 */
export default async function GuestRecapIndexPage({
  params,
}: Readonly<GuestRecapIndexPageProps>): Promise<React.JSX.Element> {
  const rawParams = await params;
  const headerList = await headers();

  const parsed = paramsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return <LinkNotActive />;
  }
  const { token } = parsed.data;

  const clientIpHash = hashedClientIp(headerList);

  const result = await loadGuestRecapIndex({ rawToken: token, clientIpHash });
  if (result === null) {
    return <LinkNotActive />;
  }

  // ⚠⚠ OUTSIDE ANY `try` — see the docblock above and `load-guest-recap-index.ts`'s own.
  if (result.kind === 'redirect') {
    redirect(result.href);
  }

  trackServerAndFlush(GUEST_SERVER_EVENTS.GUEST_RECAP_INDEX_VIEWED, {
    meeting_count: result.rows.length,
    // ⚠ `meeting_guests.id` — a guest has NO user id.
    distinct_id: result.guestId,
  });

  return <GuestRecapIndexCard rows={result.rows} token={token} />;
}
