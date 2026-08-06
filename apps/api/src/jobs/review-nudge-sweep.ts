import { Worker, type Job } from 'bullmq';
import {
  agenciesRepository,
  caseEngagementsRepository,
  companiesRepository,
  expertsRepository,
  meetingPresenceRepository,
  projectEngagementsRepository,
  reviewsRepository,
  usersRepository,
  type RatingNudgeCandidate,
} from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { quantiseNudgeTick, reviewNudgeBands, type ReviewNudgeStep } from '@balo/shared/reviews';
import { trackServer, REVIEW_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';
import { mintReviewInviteToken } from '../lib/review-token.js';

/**
 * BAL-390 — the star-rating nudge sweep: a single repeatable BullMQ job that, each tick,
 * finds engagements whose TERMINAL ANCHOR crossed one of two cadence steps (+24h / +7d)
 * during the last cron period and publishes ONE `review.reminder` per unrated
 * client-side reviewer, each carrying its own freshly minted magic-link token.
 *
 * Modelled function-for-function on `onboarding-reminder-sweep.ts` (BAL-374), which is
 * the CORRECT sweep precedent in this codebase.
 *
 * ⚠⚠ `auto-accept-sweep.ts`'s REMINDER pass is deliberately NOT the model here, and is
 * not cited as precedent: it runs a `(now−7d, now−5d]` — i.e. FORTY-EIGHT HOUR — band
 * against an hourly cron and leans on BullMQ jobId dedup to collapse the ~48 repeat
 * matches. That dedup cannot hold: `../lib/queue.ts` sets `removeOnComplete: { count: 100 }`
 * on ONE `notification-events` queue shared by every event type, so a completed job's id
 * is evicted after 100 completions ACROSS ALL TYPES. That defect is ticketed separately;
 * do not copy it, and do not "harmonise" this file toward it.
 *
 * ⚠⚠ THE LOAD-BEARING INVARIANT: BAND WIDTH == CRON PERIOD, both ONE HOUR.
 * `REVIEW_NUDGE_WINDOW_MS` lives in `@balo/shared/reviews` with the full argument;
 * `review-nudge-sweep.test.ts` asserts it equals this file's cron period. A band WIDER
 * than the period re-matches the same row on consecutive ticks (see above — nothing
 * would collapse the duplicates); a band NARROWER leaves permanent gaps.
 *
 * ⚠⚠ AND THE TICK IS QUANTISED, NOT THE RAW CLOCK. Equal width and period only partition
 * the timeline if the ticks themselves land one period apart, which a cron under load does
 * not: a late 13:04 tick followed by an on-time 14:00 one overlaps by four minutes and
 * double-mints. `runReviewNudgeSweep` floors `now` through `quantiseNudgeTick` for exactly
 * that reason — see it, and the band-math docstring, before touching either.
 *
 * TWO ANCHORS, QUERIED EVERY TICK (D5): `project_engagements.accepted_at` and
 * `case_engagements.closed_at`. The CASE reader returns `[]` today — `close()` has zero
 * production callers, so nothing stamps `closed_at` yet — and that is EXPECTED, not dead
 * code: it self-activates with zero code change the moment BAL-420/BAL-421 land. The
 * unit test asserts both anchors are queried precisely so a future "the case one always
 * returns empty, drop it" cannot land.
 *
 * NO THIRD NUDGE, AND NO SCHEMA STATE. An anchor older than `7d + 1h` is outside every
 * band forever, so the hard stop is window math: no `nudge_sent_at` column, no
 * `last_nudge_step`, no cancellation code. It is PROVEN by the band-math unit tests in
 * `@balo/shared/reviews` and by nothing else — `notification_log` CANNOT record these at
 * all (`notifications.correlation_id` is `uuid NOT NULL` while every sweep here writes a
 * composite string, so the insert is rejected `22P02` and swallowed by the log channel's
 * own try/catch). Do not plan an observability check against that table.
 *
 * NUDGES STOP ONCE A REVIEW EXISTS, ALSO WITHOUT CANCELLATION CODE: the candidate queries
 * fold a `NOT EXISTS` over live reviews into SQL. The AC is satisfied by the query no
 * longer matching, not by cancelling anything.
 *
 * ⚠ THAT SUPPRESSION IS ENGAGEMENT-LEVEL, AND IT IS A RATIFIED DECISION (2026-08-06), not
 * an oversight. The `NOT EXISTS` is keyed on (engagement, expert) with NO reviewer
 * predicate, so the FIRST review from ANYONE ends the nudges for EVERY other unrated
 * participant on that engagement. Rationale: a rating is signal about the expert's
 * delivery, and one is enough to have it — we are not chasing per-person completion, and
 * emailing colleagues after someone already answered reads as nagging the company.
 *
 * This is LIVE TODAY; it is not waiting on unbuilt tickets. Worked example:
 *   Northwind's admin Dana accepts the project and taps 4 stars in the accept email (that
 *   email is addressed to the ACTING member — `recipient: 'self'` — not to the owner).
 *   Northwind's owner Sam then receives NEITHER the +24h nor the +7d nudge, because the
 *   engagement left the candidate set the moment Dana's row committed.
 * When BAL-129/134 give `meeting_presence` a production writer this widens from {owner}
 * to {every recorded attendee} — same rule, more people silenced by one answer. If that
 * ever becomes undesirable it is a RE-DECISION, not a bug fix: drop the `NOT EXISTS` from
 * `listAcceptedBetween` / `listClosedBetween` and let `filterUnratedReviewers` be the sole
 * suppression. It already runs per reviewer, and THIS SWEEP NEEDS NO CHANGE — `nudgeCandidate`
 * already returns 0 on an empty reviewer list.
 *
 * ⚠ CONSEQUENTLY `filterUnratedReviewers` IS NOT A SECOND LAYER OF DEFENCE. Once any review
 * exists the engagement never reaches it, so its only live function is the sub-second race
 * of a review landing between the candidate SELECT and the publish inside a single tick. It
 * can only narrow a candidate set, never widen one — do not reason about it as reviewer-level
 * coverage that backstops the SQL.
 */
export const REVIEW_NUDGE_SWEEP_QUEUE = 'review-nudge-sweep';

/**
 * ⚠⚠ HOURLY — AND NOT A FREE KNOB. This period MUST equal `REVIEW_NUDGE_WINDOW_MS` in
 * `@balo/shared/reviews`; read that constant's warning before changing either. The
 * ticket says "~24h", so a DAILY cron — which would make step 1 fire anywhere inside a
 * whole extra day — is WRONG.
 */
export const REVIEW_NUDGE_SWEEP_CRON = '0 * * * *';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "4 Jul" — day + short month, UTC. Matches `auto-accept-sweep.ts`'s and the web
 * actions' `formatShortUtc` so sweep-published copy reads identically to web-published
 * copy.
 */
function formatShortUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/** The two party labels the nudge copy needs (BAL-329: prospective copy names the PARTY). */
interface NudgeDisplayFields {
  clientCompanyName: string;
  expertPartyLabel: string;
}

/**
 * Derive the payload's display fields for one candidate, folded through the shared
 * BAL-329 `expertPartyDisplayName` rule so an agency-based expert is named by their
 * agency and an independent one by their own name — identical to what the web surfaces
 * and the auto-accept sweep render.
 *
 * Resolved ONCE PER ENGAGEMENT (not per reviewer). Returns `undefined` when the company
 * or the expert profile cannot be read at all, which is a structural impossibility given
 * the engagement's foreign keys — the guard exists so a genuinely broken row is SKIPPED
 * WITH A LOG rather than emailing "An expert" to a real client.
 */
async function resolveDisplayFields(
  candidate: RatingNudgeCandidate
): Promise<NudgeDisplayFields | undefined> {
  const company = await companiesRepository.findById(candidate.companyId);
  const profile = await expertsRepository.findProfileById(candidate.expertProfileId);
  if (company === undefined || profile === undefined) {
    return undefined;
  }

  const expertUser = await usersRepository.findById(profile.userId);
  const agency =
    profile.agencyId === null
      ? undefined
      : await agenciesRepository.getSummaryById(profile.agencyId);

  return {
    clientCompanyName: company.name,
    expertPartyLabel: expertPartyDisplayName({
      type: profile.type,
      agencyName: agency?.name ?? null,
      firstName: expertUser?.firstName ?? null,
      lastName: expertUser?.lastName ?? null,
    }),
  };
}

/**
 * WHO gets asked about this engagement — a DELIBERATELY NARROW set:
 *
 *  (a) PARTICIPATION — client-side people observed in a live meeting for this
 *      engagement. ⚠ EMPTY TODAY: BAL-418 shipped the `meetings` table but there is no
 *      production writer (BAL-129/134 unbuilt), so this is a real, tested FORWARD SEAM
 *      that self-widens the instant meetings ship. Do not expect nudges from it in a
 *      manual test.
 *  (b) THE CLIENT COMPANY'S OWNER — ALWAYS, on every tick, NOT a fallback. The owner is
 *      unioned into (a) unconditionally and the `Set` drops the duplicate when they were
 *      also in the meeting; the union is never guarded on (a) being empty. That is
 *      deliberate, not an oversight to "tidy up": the owner is the accountable recipient
 *      for the party, and a guard would silence them the moment ONE attendee is recorded —
 *      a regression that would arrive silently with the first meetings writer. Today (a) is
 *      empty, so the owner happens to be the only live recipient; that is a CONSEQUENCE of
 *      the seam, never the mechanism. `findOwnerUserIdByCompanyId` is the non-throwing
 *      variant (a retainer / owner-miss is expected, not an error) and projects only the
 *      id, so no user row is hydrated. It is exactly the recipient `auto-accept-sweep.ts`
 *      already uses.
 *  (c) SEND-TIME review-absence re-check, per reviewer.
 *
 * ⚠ SURFACING IS NOT AUTHORIZATION (D10). NO ROLE STRING AND NO CAPABILITY IS READ HERE.
 * This asks people with an unrated PARTICIPATION, which is narrower than "every member
 * holding PARTICIPATE" — do not widen it to a membership fan-out. The capability gate
 * runs at SUBMIT time, in the web Server Action, on every submit.
 */
async function resolveUnratedReviewers(candidate: RatingNudgeCandidate): Promise<string[]> {
  const participants = await meetingPresenceRepository.listClientUserIdsForEngagement(
    candidate.engagementId
  );
  const owner = await companiesRepository.findOwnerUserIdByCompanyId(candidate.companyId);

  const candidateUserIds = [...new Set([...participants, ...(owner === undefined ? [] : [owner])])];

  return reviewsRepository.filterUnratedReviewers({
    engagementId: candidate.engagementId,
    expertProfileId: candidate.expertProfileId,
    candidateUserIds,
  });
}

/**
 * Mint + publish + track for ONE reviewer.
 *
 * ⚠ ONE EVENT PER REVIEWER, NEVER A FAN-OUT. `reviewToken` is per-person and the
 * dispatcher shares ONE payload across a whole fan-out, so a fan-out recipient kind
 * would put this person's magic link in everyone else's inbox. That is a correctness
 * constraint, not a style preference — the per-recipient publish is asserted in the
 * unit test.
 *
 * The token is minted BEFORE the publish (a publish carrying no token is useless) and
 * the RAW value rides the payload — the stored value is its SHA-256 hash.
 *
 * The `correlationId` is belt-and-braces ONLY: the real once-ness comes from the band
 * math, because BullMQ jobId dedup cannot be relied on here (see the module docstring).
 */
async function nudgeOne(
  candidate: RatingNudgeCandidate,
  fields: NudgeDisplayFields,
  reviewerUserId: string,
  step: ReviewNudgeStep
): Promise<void> {
  const reviewToken = await mintReviewInviteToken({
    engagementId: candidate.engagementId,
    reviewerUserId,
  });

  await notificationEvents.publish('review.reminder', {
    correlationId: `${candidate.engagementId}:${reviewerUserId}:review_nudge:${step}`,
    engagementId: candidate.engagementId,
    userId: reviewerUserId, // → recipient 'self' + the resolver hydrates data.user
    reviewToken,
    cadenceStep: step,
    engagementKind: candidate.engagementKind,
    engagementTitle: candidate.title,
    expertPartyLabel: fields.expertPartyLabel,
    clientCompanyName: fields.clientCompanyName,
    anchorDate: formatShortUtc(candidate.anchorAt),
    // CASE ONLY — `undefined` on the project arm and on a case with no reason recorded,
    // which is exactly what the template's reason-blind fallback is for.
    closeReason: candidate.closeReason,
  });

  trackServer(REVIEW_SERVER_EVENTS.NUDGE_SENT, {
    cadence_step: step,
    engagement_kind: candidate.engagementKind,
    distinct_id: reviewerUserId, // the reviewer — NEVER the token
  });
}

/**
 * Nudge every unrated reviewer of one candidate engagement at one cadence step. Returns
 * the number of successful publishes. Each RECIPIENT is isolated in its own try/catch —
 * one bad recipient never costs the others their nudge.
 *
 * The reviewer set is resolved BEFORE the display fields so an engagement whose whole
 * client side has already rated costs three reads and no name lookups.
 */
async function nudgeCandidate(
  candidate: RatingNudgeCandidate,
  step: ReviewNudgeStep,
  log: (message: string) => void
): Promise<number> {
  const reviewers = await resolveUnratedReviewers(candidate);
  if (reviewers.length === 0) {
    return 0;
  }

  const fields = await resolveDisplayFields(candidate);
  if (fields === undefined) {
    log(
      `review nudge step ${step} skipped for engagement ${candidate.engagementId}: display fields unresolved`
    );
    return 0;
  }

  let sent = 0;
  for (const reviewerUserId of reviewers) {
    try {
      await nudgeOne(candidate, fields, reviewerUserId, step);
      sent += 1;
    } catch (error) {
      log(
        `review nudge step ${step} failed for engagement ${candidate.engagementId} reviewer ${reviewerUserId}: ${errorMessage(error)}`
      );
    }
  }
  return sent;
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). For each
 * cadence step it resolves the half-open `(after, until]` band from the shared band math
 * and queries BOTH terminal anchors, then nudges every unrated reviewer of every
 * matching engagement. Each ROW is isolated in its own try/catch — one bad row never
 * aborts the batch. Returns the count of successful publishes.
 *
 * ⚠ `now` IS FLOORED TO THE HOUR GRID BEFORE ANY BAND IS COMPUTED. A cron tick is not
 * punctual, and the half-open bands only abut when the ticks do: a late 13:04 tick and the
 * next on-time 14:00 tick overlap over `(…13:00, …13:04]`, and every anchor in those four
 * minutes gets nudged TWICE — two magic-link tokens minted, two `review_nudge_sent`
 * events. Quantising snaps both ticks onto the same grid, so each hour's band is swept by
 * exactly one tick. A tick running late WITHIN its hour still sweeps its own band; a tick
 * that never runs at all still loses its band forever (D1: no sent-marker, nothing to
 * reconcile against). The caller-supplied `now` stays a parameter so this remains a pure
 * function of its argument in the tests.
 */
export async function runReviewNudgeSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ sent: number }> {
  let sent = 0;
  const tick = quantiseNudgeTick(now);

  for (const { step, after, until } of reviewNudgeBands(tick)) {
    // D5 — BOTH anchors, EVERY tick. The case reader is empty until BAL-420/BAL-421
    // stamp `closed_at`; that is the seam, not dead code.
    const accepted = await projectEngagementsRepository.listAcceptedBetween(after, until);
    const closed = await caseEngagementsRepository.listClosedBetween(after, until);

    for (const candidate of [...accepted, ...closed]) {
      try {
        sent += await nudgeCandidate(candidate, step, log);
      } catch (error) {
        log(
          `review nudge step ${step} failed for engagement ${candidate.engagementId}: ${errorMessage(error)}`
        );
      }
    }
  }

  return { sent };
}

/** Start the review-nudge sweep worker. */
export function startReviewNudgeSweepWorker(): Worker {
  return new Worker(
    REVIEW_NUDGE_SWEEP_QUEUE,
    async (job: Job) => {
      const { sent } = await runReviewNudgeSweep(new Date(), (m) => job.log(m));
      job.log(`review nudge sweep: ${sent} nudges published`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable review-nudge sweep (HOURLY — coupled to the band width). */
export async function registerReviewNudgeSweepCron(): Promise<void> {
  const queue = getQueue(REVIEW_NUDGE_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: REVIEW_NUDGE_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
