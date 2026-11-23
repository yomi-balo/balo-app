import { Worker, type Job } from 'bullmq';
import {
  projectEngagementsRepository,
  companiesRepository,
  auditEventsRepository,
  reviewsRepository,
  type ProjectEngagementRow,
  type ProjectEngagementWithMilestones,
} from '@balo/db';
import { AUTO_ACCEPT_DAYS, autoAcceptAt } from '@balo/shared/engagements';
import { formatShortUtc } from '@balo/shared/timezone';
import { trackServer, ENGAGEMENT_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';
import { mapWithConcurrency } from '../lib/map-with-concurrency.js';
import { mintReviewInviteToken } from '../lib/review-token.js';
import { deliveryEmailFields, type DeliveryEmailFields } from '../lib/delivery-email-fields.js';

/**
 * BAL-338 (D7) — the delivery-review sweep: a single repeatable, HOURLY BullMQ job that, each
 * tick, AUTO-ACCEPTS every `pending_acceptance` PROJECT whose review window has elapsed. A
 * repeatable sweep (not per-engagement delayed jobs) — matching the ticket and the only
 * scheduled-job precedent in the codebase (availability-cache staleness).
 *
 * The T-2 review reminder is NOT sent here: it is the `delivery_review` sequence of the
 * reminder registry (BAL-665, ADR-1060), armed and published by the reminder-sequence sweep
 * and dispatch tick.
 *
 * PROJECT-SCOPED BY CONSTRUCTION (BAL-417): `pending_acceptance` is a
 * `project_engagements.delivery_status` label, and `listPendingAutoAccept` is a
 * child-rooted read — a Case can never be selected by this sweep, structurally rather
 * than by convention. Auto-accept is a PROJECT delivery concept; a Case's terminal
 * state is a client-initiated close (BAL-421), never an auto-accept.
 * It self-heals across withdraw→re-request (the window is re-derived from the current
 * `completion_requested_at` every run) and tolerates a missed tick (a late accept
 * rather than a lost one).
 *
 * IDEMPOTENCY: no schema state. `acceptCompletion` is guarded by the engagement status
 * (a second accept of a now-`completed` row is a no-op transition error, swallowed per
 * row).
 */
export const DELIVERY_REVIEW_SWEEP_QUEUE = 'delivery-review-sweep';

// ── Config knobs (co-located typed consts) ───────────────────────
// AUTO_ACCEPT_DAYS is the SINGLE SOURCE OF TRUTH from @balo/shared/engagements — the
// client-facing review email computes its promised auto-accept date from the SAME const
// web-side, so a second literal here would drift the promise from the sweep's behaviour. The
// cron cadence is a genuine deployment knob (it doesn't change the client-facing promise)
// and lives here as a plain typed const (no Zod env module — none exists in this app).
export const DELIVERY_REVIEW_SWEEP_CRON = '0 * * * *'; // hourly; the cutoff is absolute, so cadence only affects latency

const DAY_MS = 24 * 60 * 60 * 1000;
/** One row at a time: the auto-accept pass stays strictly sequential, as it always has been. */
const AUTO_ACCEPT_CONCURRENCY = 1;
/** The auto path has no acting user — a stable system distinct-id keeps PostHog from minting anon ids. */
const SYSTEM_DISTINCT_ID = 'system:auto-accept';

/** Whole days between two instants, never negative. */
function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The client-company owner user id, or undefined (retainer / no live owner). */
async function resolveOwnerUserId(companyId: string): Promise<string | undefined> {
  try {
    const owner = await companiesRepository.findOwnerByCompanyId(companyId);
    return owner.id;
  } catch {
    return undefined;
  }
}

/** Best-effort review-cycle (prior completion-request audit rows); degrades to 1. */
async function readReviewCycle(engagementId: string): Promise<number> {
  try {
    return await auditEventsRepository.countByEntityAndAction({
      entityType: 'engagement',
      entityId: engagementId,
      action: 'engagement.completion_requested',
    });
  } catch {
    return 1;
  }
}

interface DisplayFields extends DeliveryEmailFields {
  recipientId: string | undefined;
}

/** The shared delivery-email display fields plus the live client-company owner. */
async function deriveDisplayFields(
  engagement: ProjectEngagementWithMilestones
): Promise<DisplayFields> {
  return {
    ...deliveryEmailFields(engagement),
    recipientId: await resolveOwnerUserId(engagement.company.id),
  };
}

/**
 * BAL-390 (D7) — the RAW magic-link token that fuses the star-rating ask into the
 * EXISTING auto-accept email, or `undefined`.
 *
 * `undefined` when there is no client recipient (retainer / owner-miss), when that
 * person has ALREADY rated this expert on this engagement, or when the mint fails. The
 * template treats all three identically: the star block is omitted ENTIRELY (not
 * greyed — gone), so the email renders exactly as it did before BAL-390.
 *
 * ⚠ NEVER THROWS, BUT NEVER SILENT EITHER. A rating token is a nice-to-have;
 * auto-accepting a delivered project and telling the expert and the admins about it is the
 * money path, and a token failure must never cost that — so the failure is caught here and
 * the email simply renders without the star row. It is REPORTED, though: the caller's per-
 * row `log` callback is threaded in (the same callback the sweep already uses for
 * auto-accept and reminder failures, and the same shape `review-nudge-sweep.ts` uses), so
 * a mint that keeps failing shows up in the job log instead of being invisible. CLAUDE.md
 * forbids the swallow this used to be.
 *
 * WARN, NOT ERROR — and deliberately so. The ask is not lost: `review-nudge-sweep.ts`
 * re-mints a fresh token for this same owner at +24h and again at +7d, so a failure here
 * costs one email's star row, not the review. (The callback carries no severity level — it
 * writes to the BullMQ job log — so the WARNING framing lives in the wording; do not
 * escalate this to an error-level structured log.)
 *
 * ⚠ NEVER LOG THE TOKEN OR ITS HASH. Ids and the error message only, exactly as the web
 * twin (`accept-project.ts`'s `resolveReviewAsk`) does.
 */
async function resolveReviewToken(
  engagementId: string,
  expertProfileId: string,
  reviewerUserId: string | undefined,
  log: (message: string) => void
): Promise<string | undefined> {
  if (reviewerUserId === undefined) return undefined;
  try {
    const existing = await reviewsRepository.findLive(
      engagementId,
      reviewerUserId,
      expertProfileId
    );
    if (existing !== undefined) return undefined;
    return await mintReviewInviteToken({ engagementId, reviewerUserId });
  } catch (error) {
    log(
      `warning: review invite token skipped for engagement ${engagementId} reviewer ${reviewerUserId} — the auto-accept email sends without the rating ask and the +24h review nudge re-mints: ${errorMessage(error)}`
    );
    return undefined;
  }
}

/**
 * Auto-accept one engagement (status-guarded in the repo) and fan out the
 * `engagement.auto_accepted` notifications (client + expert + admins) plus the
 * `engagement_accepted` (method=auto) analytics.
 *
 * DURABILITY: this is a post-commit dual write — the DB commits `completed` (with the
 * `engagement.accepted` audit event IN the same tx), THEN the notification publishes.
 * A crash in between loses the admin "ready to invoice" money signal for that row (the
 * next sweep won't re-pick it — it's already `completed`), matching the fire-and-forget
 * precedent everywhere else in delivery (D1-D4). It is RECOVERABLE from the in-tx
 * `audit_events` row; the eventual hardening is an audit-events reconciliation / outbox
 * (deferred, tracked in the PR).
 */
async function autoAcceptOne(
  engagement: ProjectEngagementRow,
  now: Date,
  log: (message: string) => void
): Promise<void> {
  const requestedAt = engagement.completionRequestedAt;
  if (requestedAt === null) return; // a pending_acceptance row always has this; defensive.

  const accepted = await projectEngagementsRepository.acceptCompletion({
    engagementId: engagement.id,
    method: 'auto',
  });
  const acceptedAt = accepted.acceptedAt ?? now;
  const autoAt = autoAcceptAt(requestedAt);

  const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
  if (hydrated === undefined) return;
  const fields = await deriveDisplayFields(hydrated);
  const reviewCycle = await readReviewCycle(engagement.id);
  // BAL-390 (D7): ONE email, never two — the star row rides THIS payload rather than a
  // second project email. Absent ⇒ no recipient, already rated, or a mint failure (which
  // is the only one of the three that logs — the other two are ordinary outcomes).
  const reviewToken = await resolveReviewToken(
    engagement.id,
    engagement.expertProfileId,
    fields.recipientId,
    log
  );

  await notificationEvents.publish('engagement.auto_accepted', {
    correlationId: `${engagement.id}:auto_accepted`,
    engagementId: engagement.id,
    recipientId: fields.recipientId,
    expertProfileId: engagement.expertProfileId,
    clientCompanyName: fields.clientCompanyName,
    expertPartyLabel: fields.expertPartyLabel,
    projectTitle: fields.projectTitle,
    milestonesTotal: fields.milestonesTotal,
    requestedDate: formatShortUtc(requestedAt),
    autoDate: formatShortUtc(autoAt),
    reviewDays: AUTO_ACCEPT_DAYS,
    reviewToken,
  });

  trackServer(ENGAGEMENT_SERVER_EVENTS.ACCEPTED, {
    engagement_id: engagement.id,
    acceptance_method: 'auto',
    days_in_review: wholeDaysBetween(requestedAt, acceptedAt),
    review_cycle: reviewCycle,
    distinct_id: SYSTEM_DISTINCT_ID,
  });
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker): auto-accepts
 * every `pending_acceptance` project whose review window has elapsed. Each row is isolated in
 * its own try/catch — one bad row never aborts the batch. Returns the count for
 * logging/assertions.
 */
export async function runDeliveryReviewSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ accepted: number }> {
  const autoAcceptCutoff = new Date(now.getTime() - AUTO_ACCEPT_DAYS * DAY_MS);
  const dueForAccept = await projectEngagementsRepository.listPendingAutoAccept(autoAcceptCutoff);
  const outcomes = await mapWithConcurrency(
    dueForAccept,
    AUTO_ACCEPT_CONCURRENCY,
    async (engagement) => {
      try {
        await autoAcceptOne(engagement, now, log);
        return true;
      } catch (error) {
        log(`auto-accept failed for engagement ${engagement.id}: ${errorMessage(error)}`);
        return false;
      }
    }
  );

  return { accepted: outcomes.filter(Boolean).length };
}

/** Start the delivery-review sweep worker (auto-accept). */
export function startDeliveryReviewSweepWorker(): Worker {
  return new Worker(
    DELIVERY_REVIEW_SWEEP_QUEUE,
    async (job: Job) => {
      const { accepted } = await runDeliveryReviewSweep(new Date(), (m) => job.log(m));
      await job.log(`delivery review sweep: ${accepted} auto-accepted`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable delivery-review sweep (hourly). */
export async function registerDeliveryReviewSweepCron(): Promise<void> {
  const queue = getQueue(DELIVERY_REVIEW_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: DELIVERY_REVIEW_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
