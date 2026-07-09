import { Worker, type Job } from 'bullmq';
import {
  engagementsRepository,
  companiesRepository,
  auditEventsRepository,
  AUTO_ACCEPT_DAYS,
  type Engagement,
  type EngagementWithMilestones,
} from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { trackServer, ENGAGEMENT_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';

/**
 * BAL-338 (D7) — the delivery-review sweep: a single repeatable BullMQ job that, each
 * tick, (1) AUTO-ACCEPTS every `pending_acceptance` engagement whose review window has
 * elapsed and (2) sends the ONE T-2 review reminder to engagements approaching the
 * deadline. A repeatable sweep (not per-engagement delayed jobs) — matching the ticket
 * and the only scheduled-job precedent in the codebase (availability-cache staleness).
 * It self-heals across withdraw→re-request (the window is re-derived from the current
 * `completion_requested_at` every run) and tolerates a missed tick (a late accept /
 * reminder rather than a lost one).
 *
 * IDEMPOTENCY: no schema state. `acceptCompletion` is guarded by the engagement status
 * (a second accept of a now-`completed` row is a no-op transition error, swallowed per
 * row). The reminder rides the notification engine's correlationId
 * (`${engagementId}:review_reminder:${completionRequestedAtMs}`) — the ticket's stated
 * key (engagement id + request timestamp): the daily sweep matching the same row on
 * both T-2 and T-1 mints the SAME key → one nudge; a genuine re-request re-reminds.
 */
export const DELIVERY_REVIEW_SWEEP_QUEUE = 'delivery-review-sweep';

// ── Config knobs (co-located typed consts) ───────────────────────
// AUTO_ACCEPT_DAYS is the SINGLE SOURCE OF TRUTH from @balo/db — the client-facing
// review email computes its promised auto-accept date from the SAME const web-side, so
// a second literal here would drift the promise from the sweep's behaviour. The
// reminder lead + cron cadence are genuine deployment knobs (they don't change the
// client-facing promise) and live here as plain typed consts (no Zod env module — none
// exists in this app; a fixed policy value is a const, mirroring QUIET_THRESHOLD_DAYS).
export const REVIEW_REMINDER_LEAD_DAYS = 2; // T-2: nudge this many days before auto-accept
export const DELIVERY_REVIEW_SWEEP_CRON = '0 * * * *'; // hourly; the cutoff is absolute, so cadence only affects latency

const DAY_MS = 24 * 60 * 60 * 1000;
/** The auto path has no acting user — a stable system distinct-id keeps PostHog from minting anon ids. */
const SYSTEM_DISTINCT_ID = 'system:auto-accept';

/** "4 Jul" — day + short month, UTC (matches the web actions' formatShortUtc). */
function formatShortUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

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

interface DisplayFields {
  clientCompanyName: string;
  expertPartyLabel: string;
  projectTitle: string;
  milestonesTotal: number;
  recipientId: string | undefined;
}

/**
 * Derive the notification payload's display fields from the hydrated engagement,
 * reusing the shared BAL-329 party-label rule (`expertPartyDisplayName`) so the
 * sweep-published copy matches the web-published copy exactly.
 */
async function deriveDisplayFields(engagement: EngagementWithMilestones): Promise<DisplayFields> {
  const { user, agency, type } = engagement.expertProfile;
  const expertPartyLabel = expertPartyDisplayName({
    type,
    agencyName: agency?.name ?? null,
    firstName: user.firstName,
    lastName: user.lastName,
  });
  const projectTitle =
    engagement.projectRequest?.title?.trim() || `Delivery with ${expertPartyLabel}`;
  const recipientId = await resolveOwnerUserId(engagement.company.id);
  return {
    clientCompanyName: engagement.company.name,
    expertPartyLabel,
    projectTitle,
    milestonesTotal: engagement.milestones.length,
    recipientId,
  };
}

/** The promised auto-accept instant for a completion request (requestedAt + window). */
function autoAcceptDate(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + AUTO_ACCEPT_DAYS * DAY_MS);
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
async function autoAcceptOne(engagement: Engagement, now: Date): Promise<void> {
  const requestedAt = engagement.completionRequestedAt;
  if (requestedAt === null) return; // a pending_acceptance row always has this; defensive.

  const accepted = await engagementsRepository.acceptCompletion({
    engagementId: engagement.id,
    method: 'auto',
  });
  const acceptedAt = accepted.acceptedAt ?? now;
  const autoAt = autoAcceptDate(requestedAt);

  const hydrated = await engagementsRepository.findEngagementWithMilestones(engagement.id);
  if (hydrated === undefined) return;
  const fields = await deriveDisplayFields(hydrated);
  const reviewCycle = await readReviewCycle(engagement.id);

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
 * Send the T-2 review reminder for one engagement. No-op when the client company has
 * no live owner (retainer / owner-miss). The correlationId dedups repeated daily
 * matches to a single nudge (see the module docstring).
 */
async function remindOne(engagement: Engagement, now: Date): Promise<boolean> {
  const requestedAt = engagement.completionRequestedAt;
  if (requestedAt === null) return false;

  const hydrated = await engagementsRepository.findEngagementWithMilestones(engagement.id);
  if (hydrated === undefined) return false;
  const fields = await deriveDisplayFields(hydrated);
  if (fields.recipientId === undefined) return false; // no one to remind (retainer / owner-miss).

  const autoAt = autoAcceptDate(requestedAt);
  const daysLeft = Math.max(1, Math.ceil((autoAt.getTime() - now.getTime()) / DAY_MS));

  await notificationEvents.publish('engagement.review_reminder', {
    correlationId: `${engagement.id}:review_reminder:${requestedAt.getTime()}`,
    engagementId: engagement.id,
    recipientId: fields.recipientId,
    clientCompanyName: fields.clientCompanyName,
    expertPartyLabel: fields.expertPartyLabel,
    projectTitle: fields.projectTitle,
    milestonesTotal: fields.milestonesTotal,
    requestedDate: formatShortUtc(requestedAt),
    autoDate: formatShortUtc(autoAt),
    daysLeft,
  });

  trackServer(ENGAGEMENT_SERVER_EVENTS.REVIEW_REMINDER_SENT, {
    engagement_id: engagement.id,
    distinct_id: fields.recipientId,
  });
  return true;
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). Runs the
 * auto-accept pass FIRST so the reminder pass can never nudge a row that auto-accepts
 * the same tick, then reminds the remaining rows inside the T-2 window. Each row is
 * isolated in its own try/catch — one bad row never aborts the batch. Returns the
 * per-pass counts for logging/assertions.
 */
export async function runDeliveryReviewSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ accepted: number; reminded: number }> {
  const autoAcceptCutoff = new Date(now.getTime() - AUTO_ACCEPT_DAYS * DAY_MS);
  const reminderCutoff = new Date(
    now.getTime() - (AUTO_ACCEPT_DAYS - REVIEW_REMINDER_LEAD_DAYS) * DAY_MS
  );

  // 1) Auto-accept everything past the window first.
  const dueForAccept = await engagementsRepository.listPendingAutoAccept(autoAcceptCutoff);
  let accepted = 0;
  for (const engagement of dueForAccept) {
    try {
      await autoAcceptOne(engagement, now);
      accepted += 1;
    } catch (error) {
      log(`auto-accept failed for engagement ${engagement.id}: ${errorMessage(error)}`);
    }
  }

  // 2) Remind the remaining pending rows within the T-2 window. The query gives the
  //    UPPER edge (completion_requested_at <= reminderCutoff); we bound the LOWER edge
  //    to `> autoAcceptCutoff` in code so the reminder window is exactly (T-7, T-2].
  //    Without the lower bound, a row that FAILED to auto-accept this tick (repo error)
  //    would linger past its deadline and get a reminder whose autoDate is already in
  //    the past (daysLeft clamped to 1) — this makes the reminder robust regardless of
  //    the accept pass, and such a row is simply retried by the accept pass next tick.
  const dueForReminder = (await engagementsRepository.listPendingAutoAccept(reminderCutoff)).filter(
    (engagement) =>
      engagement.completionRequestedAt !== null &&
      engagement.completionRequestedAt.getTime() > autoAcceptCutoff.getTime()
  );
  let reminded = 0;
  for (const engagement of dueForReminder) {
    try {
      if (await remindOne(engagement, now)) {
        reminded += 1;
      }
    } catch (error) {
      log(`review reminder failed for engagement ${engagement.id}: ${errorMessage(error)}`);
    }
  }

  return { accepted, reminded };
}

/** Start the delivery-review sweep worker (auto-accept + T-2 reminder). */
export function startDeliveryReviewSweepWorker(): Worker {
  return new Worker(
    DELIVERY_REVIEW_SWEEP_QUEUE,
    async (job: Job) => {
      const { accepted, reminded } = await runDeliveryReviewSweep(new Date(), (m) => job.log(m));
      job.log(`delivery review sweep: ${accepted} auto-accepted, ${reminded} reminded`);
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
