import {
  consultationsRepository,
  expertsRepository,
  resolveClientCompaniesForMeetings,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { expandOverrideBlocks } from './resolver-inputs.js';

const log = createLogger('availability-override-conflicts');

/**
 * BAL-416 — how many conflicting consultations get their client company resolved and
 * returned in full. `conflictCount` is always exact; this only bounds the DETAIL rows, so a
 * three-month sabbatical over 100+ bookings still renders a legible popover.
 */
export const CONFLICT_DETAIL_LIMIT = 20;

export interface OverrideConflictDetail {
  consultationId: string;
  startAt: Date;
  endAt: Date;
  /** `null` when the meeting's contexts name no resolvable company (fail-closed). */
  clientCompanyName: string | null;
}

export type FindOverrideConflictsResult =
  | { outcome: 'expert_not_found' }
  | {
      outcome: 'ok';
      timezone: string;
      conflictCount: number;
      truncated: boolean;
      conflicts: OverrideConflictDetail[];
    };

export interface FindOverrideConflictsInput {
  expertProfileId: string;
  /**
   * BAL-416 fix round 1 (S1) — the calling session's OWN `users.id`, asserted against
   * `expertProfiles.userId` before any cross-party data (client company names) is read.
   * `expertProfileId` alone is caller-supplied and publicly harvestable (`GET
   * /api/experts/search`), so it cannot double as authorization. A mismatch answers the
   * SAME `expert_not_found` outcome as a genuinely missing profile — never a discriminable
   * error — so this assertion cannot become an existence oracle.
   */
  userId: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, INCLUSIVE. */
  endDate: string;
  /** UTC instant; injected for testability. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Does a proposed time-off block (`startDate`–`endDate`, inclusive, in the expert's own
 * schedule timezone) collide with any already-CONFIRMED consultation? Read-only — this
 * never cancels, moves or refunds anything (BAL-416 is detect-and-warn only; BAL-410 owns
 * any resolution beyond "block anyway").
 *
 * ⚠ D1 — THE TIMEZONE EXPANSION IS THE SAME `expandOverrideBlocks` THE RESOLVER USES, called
 * with a ONE-ELEMENT ARRAY. A second expansion could disagree with the resolver about the
 * end-inclusive boundary or about DST, and the warning would lie about what the block is
 * about to do.
 *
 * ⚠ D4 — THE RANGE IS THE BARE EXPANDED INTERVAL, CLAMPED FORWARD TO `now`. No
 * `CONSULTATION_LOAD_PAD_MS`: that padding exists so a booking's buffer can still collide
 * with a neighbouring window, which is irrelevant to "does an existing session fall inside
 * the days I am about to block" and would produce a false positive on the day before/after
 * the block. The forward clamp drops sessions that have already finished earlier today —
 * not a decision the expert can make — while a session still in progress (`endAt > now`)
 * still surfaces.
 *
 * ⚠ D3 — `consultationsRepository` IS UNCHANGED. `listConfirmedInRange`'s overlap predicate
 * (`startAt < rangeEnd AND endAt > rangeStart`, strict both ends) is exactly the definition
 * the warning must speak, because it is the same predicate the resolver uses to decide a
 * slot is taken. A second overlap predicate here could disagree with the resolver about a
 * session ending exactly at midnight.
 */
export async function findOverrideConflicts(
  input: FindOverrideConflictsInput
): Promise<FindOverrideConflictsResult> {
  const now = input.now ?? new Date();

  const settings = await expertsRepository.findResolverSettings(input.expertProfileId);
  // S1 — a mismatched `userId` collapses into the SAME not-found outcome as a missing
  // profile (never a distinguishable 403), so this check cannot be used to enumerate which
  // expert profile ids exist.
  if (settings === null || settings.userId !== input.userId) {
    return { outcome: 'expert_not_found' };
  }
  const timezone = settings.timezone;

  const [block] = expandOverrideBlocks(
    [{ startDate: input.startDate, endDate: input.endDate }],
    timezone
  );
  if (block === undefined) {
    // Unreachable — `expandOverrideBlocks` maps a one-element array to a one-element array.
    throw new Error('findOverrideConflicts: expandOverrideBlocks returned no block');
  }

  const rangeStart = new Date(Math.max(block.startAt.getTime(), now.getTime()));
  const rangeEnd = block.endAt;

  if (rangeStart >= rangeEnd) {
    // All-past block — unreachable via the picker (it disables past dates), but a
    // clock-injected test can reach it. No query needed: nothing in the past can conflict.
    return { outcome: 'ok', timezone, conflictCount: 0, truncated: false, conflicts: [] };
  }

  const rows = await consultationsRepository.listConfirmedInRange(
    input.expertProfileId,
    rangeStart,
    rangeEnd
  );

  const conflictCount = rows.length;
  if (conflictCount === 0) {
    return { outcome: 'ok', timezone, conflictCount: 0, truncated: false, conflicts: [] };
  }

  const sorted = [...rows].sort((a, b) => {
    const byStart = a.startAt.getTime() - b.startAt.getTime();
    return byStart === 0 ? a.id.localeCompare(b.id) : byStart;
  });
  const truncated = conflictCount > CONFLICT_DETAIL_LIMIT;
  const detailRows = sorted.slice(0, CONFLICT_DETAIL_LIMIT);

  // Q5 — the truncation notice logs at the ROUTE, via `request.log.info`, not here: that is
  // the only place the `requestId`/`userId` AsyncLocalStorage correlation is available, and
  // the route already holds `result.conflictCount` / `result.conflicts.length` to log with.

  const companiesByMeetingId = await resolveClientCompaniesForMeetings(
    detailRows.map((row) => row.meetingId),
    // S2 — omit any meeting whose resolved context names a DIFFERENT expert than the one
    // whose consultations were listed; `meeting_contexts.context_id` carries no FK/CHECK/RLS
    // tying it back to `input.expertProfileId` on its own.
    input.expertProfileId
  );

  const conflicts: OverrideConflictDetail[] = detailRows.map((row) => {
    const company = companiesByMeetingId.get(row.meetingId);
    if (company === undefined) {
      log.warn(
        { expertProfileId: input.expertProfileId, meetingId: row.meetingId },
        'Conflicting consultation has no resolvable client company (contexts unresolvable, ambiguous, or absent)'
      );
    }
    return {
      consultationId: row.id,
      startAt: row.startAt,
      endAt: row.endAt,
      clientCompanyName: company?.companyName ?? null,
    };
  });

  return { outcome: 'ok', timezone, conflictCount, truncated, conflicts };
}
