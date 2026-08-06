import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { engagementsRepository, reviewInviteTokensRepository, reviewsRepository } from '@balo/db';
import { parsePrefillRating } from '@balo/shared/reviews';
import { CAPABILITIES, hasCapability } from '@/lib/authz';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { clientIp, hashesMatch, sha256Hex } from '@/lib/magic-link';
import { log } from '@/lib/logging';
import { LinkNotActive } from './link-not-active';
import { ReviewForm } from './_components/review-form';

// `node:crypto` (token hashing) + Drizzle need Node, not Edge.
export const runtime = 'nodejs';
// Per-token, access-stamping content — never statically cached.
export const dynamic = 'force-dynamic';

// Public magic-link page — deliberately NOT indexed, and a NEUTRAL title: the tab and
// any share preview must not name the company, the expert or the engagement.
export const metadata: Metadata = {
  title: 'Leave a review — Balo',
  robots: { index: false, follow: false },
};

interface ReviewLandingPageProps {
  /** ⚠ Next 16: BOTH of these are Promises and MUST be awaited. */
  params: Promise<{ token: string }>;
  searchParams: Promise<{ r?: string | string[] }>;
}

/**
 * ⚠⚠ THE SECURITY PROPERTY AND THE ACCEPTANCE CRITERION OF THIS FILE: **THE STAR LINK
 * PREFILLS, IT NEVER WRITES.**
 *
 * Gmail's link proxy, Microsoft Defender Safe Links detonation, Proofpoint/Barracuda
 * rewriting and MDM prefetch all issue unsolicited GETs against emailed URLs. A GET that
 * wrote would submit ratings nobody chose, silently, at marketplace scale, and corrupt
 * the aggregate irreversibly. So the ONLY write is a Next Server Action
 * (`submitTokenReviewAction`), which is POST-only by construction — it requires the
 * `Next-Action` header and a build-time action id and cannot be reached by navigation,
 * prefetch, an `<img>` or a rewritten scanner URL. `page.test.tsx` fires 20 GETs and
 * asserts ZERO upserts; `review-link-never-writes.test.ts` re-asserts it structurally.
 *
 * ⚠ NO `<Link>` ANYWHERE IN THE APP MAY POINT AT `/review/...` — Next prefetches those
 * on viewport/hover, which would stamp accesses on links nobody opened.
 *
 * Order of operations, every step load-bearing:
 *   1–2. await `params` / `searchParams` (Next 16 — a sync interface silently no-ops).
 *   3.   Rate-limit FIRST, before any hashing or DB read. That is what makes step 5
 *        affordable under a scanner storm.
 *   4–5. Hash the presented token, resolve it live-only, then re-compare in constant time.
 *   6.   Load the engagement — for its `company_id` ONLY. `ReviewLandingContext`
 *        deliberately does not carry it, and the full supertype row (which includes
 *        `balo_fee_bps`) is NEVER passed to a client component.
 *   7.   The capability gate, evaluated against the TOKEN'S SUBJECT: a departed reviewer
 *        sees the generic card, never a form they could not submit.
 *   8.   The explicit landing projection.
 *   9.   `recordAccess` — AFTER every bail-out, so a data anomaly cannot inflate it.
 *  10.   Parse the `?r=` prefill; anything that is not exactly 1–5 is a genuine empty
 *        state, never an error.
 *
 * NOTHING is captured to PostHog on GET: an outbound event on every Safe Links
 * detonation would corrupt the funnel and cannot be capped by a DB-side limiter.
 */
export default async function ReviewLandingPage({
  params,
  searchParams,
}: Readonly<ReviewLandingPageProps>): Promise<React.JSX.Element> {
  const { token } = await params;
  const search = await searchParams;
  const headerList = await headers();

  if (!checkMemoryLimit(`review-landing:${clientIp(headerList)}`)) {
    return <LinkNotActive />;
  }

  const tokenHash = sha256Hex(token);
  const row = await reviewInviteTokensRepository.findLiveByTokenHash(tokenHash);
  if (row === undefined || !hashesMatch(tokenHash, row.tokenHash)) {
    // A hash PREFIX only — enough to correlate an incident, never enough to replay.
    log.info('Review link not active', { tokenHashPrefix: tokenHash.slice(0, 8) });
    return <LinkNotActive />;
  }

  const engagement = await engagementsRepository.findById(row.engagementId);
  if (engagement === undefined) {
    return <LinkNotActive />;
  }

  const allowed = await hasCapability({ id: row.reviewerUserId }, CAPABILITIES.PARTICIPATE, {
    companyId: engagement.companyId,
  });
  if (!allowed) {
    return <LinkNotActive />;
  }

  const context = await reviewsRepository.findLandingContext(row.engagementId, row.reviewerUserId);
  if (context === undefined) {
    return <LinkNotActive />;
  }

  const existing = await reviewsRepository.findLive(
    row.engagementId,
    row.reviewerUserId,
    engagement.expertProfileId
  );

  await reviewInviteTokensRepository.recordAccess(row.id);

  // `?r=1&r=2` arrives as an array — genuinely ambiguous, so it prefills nothing rather
  // than silently picking one. Same treatment as `?r=9` or `?r=<script>`.
  const prefill = typeof search.r === 'string' ? parsePrefillRating(search.r) : null;
  const existingRating =
    existing === undefined ? null : parsePrefillRating(String(existing.rating));

  return (
    <ReviewForm
      token={token}
      context={context}
      prefill={prefill}
      existing={
        existing === undefined || existingRating === null
          ? null
          : {
              rating: existingRating,
              body: existing.body,
              ratedOnIso: (existing.lastEditedAt ?? existing.createdAt).toISOString(),
            }
      }
    />
  );
}
