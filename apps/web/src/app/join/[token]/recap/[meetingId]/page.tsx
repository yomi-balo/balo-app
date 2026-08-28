import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { z } from 'zod';
import { hashedClientIp } from '@/lib/magic-link';
import { trackServerAndFlush, GUEST_SERVER_EVENTS } from '@/lib/analytics/server';
import { LinkNotActive } from '../../link-not-active';
import { loadGuestRecap } from '../_lib/load-guest-recap';
import { GuestRecapCard } from '../_components/guest-recap-card';

// `node:crypto` (token hashing, via the loader) + Drizzle need Node, not Edge.
export const runtime = 'nodejs';
// Per-token, gate-resolved content — never statically cached.
export const dynamic = 'force-dynamic';

// Public magic-link page — deliberately NOT indexed, and a NEUTRAL title matching the
// invitation landing's own posture (never names the company, the agency or the expert).
export const metadata: Metadata = {
  title: 'The recap — Balo',
  robots: { index: false, follow: false },
};

interface GuestRecapPageProps {
  /** ⚠ Next 16: this is a Promise and MUST be awaited. */
  readonly params: Promise<{ token: string; meetingId: string }>;
}

/**
 * ⚠⚠ ZOD FIRST, BEFORE ANYTHING TOUCHES A REPOSITORY. `meetingsRepository.findById` with a
 * non-UUID `meetingId` throws Postgres `22P02`, which would render the ERROR BOUNDARY instead of
 * {@link LinkNotActive} — a visibly different outcome for one class of crafted URL, i.e. an
 * oracle. The bounds mirror the shipped guest Server Actions' own input schemas exactly.
 */
const paramsSchema = z.object({
  token: z.string().min(20).max(200),
  meetingId: z.uuid(),
});

/**
 * BAL-439 — the guest recap. `app/join/[token]/recap/[meetingId]`: the token AUTHENTICATES, the
 * `meetingId` names WHICH recap. Both grant scopes fall out of one gate with no branching here
 * (R2) — see `resolve-guest-recap-access.ts` and `load-guest-recap.ts`.
 *
 * ⚠⚠ ONE IDENTICAL CARD FOR EVERY WAY THIS CAN FAIL, exactly like `[token]/page.tsx`'s own
 * property: a bad token, a revoked guest, a wrong meeting, a not-yet-admitted guest, a declined
 * expert relationship, a meeting that has not `ended`, a malformed param, and a throttle all
 * render the SAME propless {@link LinkNotActive}. A `notFound()` would be WORSE than the card
 * here: this segment has no `not-found.tsx`, so it would fall through to the dashboard-chromed
 * root 404 — a different visual outcome for one subset of denials, i.e. a second oracle.
 *
 * ⚠ Distinguishing "not ended yet" from "not your meeting" would be a real LEAK, not a courtesy:
 * an engagement-scope guest probing `meetingId`s could otherwise enumerate which ids are
 * real-but-unfinished. Collapsed into the one card.
 *
 * Order, every step load-bearing:
 *   1. await `params` (Next 16).
 *   2. Zod-validate BOTH params.
 *   3. `loadGuestRecap` — the one call that runs the whole gate, the lifecycle check and the
 *      two artefact reads. It rate-limits TWICE internally (`:ip:` then `:gid:` — see its own
 *      docblock).
 *   4. `GUEST_RECAP_VIEWED` — SUCCESS ONLY. A denial keyed on a crafted token would itself be an
 *      enumeration signal (R12).
 *
 * ⚠⚠ fix-round-1 / S4 — THERE IS DELIBERATELY NO THIRD, PAGE-LEVEL LIMITER HERE. An earlier
 * version added `guest-recap-page:${clientIpHash}` as a "defense-in-depth" throttle ahead of
 * the loader's own `guest-recap:ip:${clientIpHash}` — but both keys share the SAME key
 * material (the request's hashed IP) and the SAME `MAX_TRACKED_KEYS = 10_000` budget, so the
 * page's limiter could never trip without the loader's `:ip:` limiter tripping too. All it
 * bought was doubling per-IP bucket cardinality against that shared budget, accelerating
 * eviction of legitimate buckets under a scanner storm. The loader's two limiters
 * (`:ip:` / `:gid:`) are the real defense-in-depth pair — see its docblock.
 */
export default async function GuestRecapPage({
  params,
}: Readonly<GuestRecapPageProps>): Promise<React.JSX.Element> {
  const rawParams = await params;
  const headerList = await headers();

  const parsed = paramsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return <LinkNotActive />;
  }
  const { token, meetingId } = parsed.data;

  const clientIpHash = hashedClientIp(headerList);

  const result = await loadGuestRecap({ rawToken: token, meetingId, clientIpHash });
  if (result === null) {
    return <LinkNotActive />;
  }

  trackServerAndFlush(GUEST_SERVER_EVENTS.GUEST_RECAP_VIEWED, {
    access_scope: result.accessScope,
    is_own_meeting: result.view.isOwnMeeting,
    summary_state: result.view.summary.state,
    // ⚠⚠ fix-round-1 / S6 (R12) — computed HERE, not in `resolveGuestSummary`, whose
    // clock-free state machine is deliberate (see `load-guest-recap.ts`). Without this,
    // "how long after a call do guests open the recap" is unanswerable — the main question
    // `GUEST_RECAP_VIEWED` exists to answer. Integer days, floored, from the SAME timestamp
    // already resolved onto the view header (`access.meeting.startedAt ?? scheduledStart`).
    days_since_meeting: daysSinceMeeting(result.view.header.occurredAtIso),
    // ⚠ `meeting_guests.id` — a guest has NO user id.
    distinct_id: result.guestId,
  });

  return <GuestRecapCard view={result.view} token={token} />;
}

const MS_PER_DAY = 86_400_000;

/** Whole days between `occurredAtIso` and now, floored, never negative. */
function daysSinceMeeting(occurredAtIso: string): number {
  const occurredAtMs = new Date(occurredAtIso).getTime();
  if (Number.isNaN(occurredAtMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - occurredAtMs) / MS_PER_DAY));
}
