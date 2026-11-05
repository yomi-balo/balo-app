import {
  availabilityOverridesRepository,
  availabilityRulesRepository,
  consultationsRepository,
  expertsRepository,
  resolveClientCompaniesForMeetings,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { freeIntervalsInRange } from './resolver.js';
import { toResolverRules } from './resolver-inputs.js';
import type { OverrideConflictDetail } from './override-conflicts.js';

const log = createLogger('availability-timezone-impact');

/** How far ahead "upcoming" reaches when counting consultations a zone switch would strand. */
export const TIMEZONE_IMPACT_HORIZON_DAYS = 90;

/**
 * Bounds the DETAIL rows (and the client-company reads behind them). `affectedCount` is
 * always exact.
 */
export const TIMEZONE_IMPACT_DETAIL_LIMIT = 20;

const DAY_MS = 86_400_000;

export type TimezoneImpactDetail = OverrideConflictDetail;

export type FindTimezoneImpactResult =
  | { outcome: 'expert_not_found' }
  | {
      outcome: 'ok';
      timezone: string;
      affectedCount: number;
      truncated: boolean;
      affected: TimezoneImpactDetail[];
      nextTimeOff: { startDate: string; endDate: string } | null;
    };

export interface FindTimezoneImpactInput {
  expertProfileId: string;
  /**
   * The calling session's OWN `users.id`, asserted against the profile's owner before any
   * client company name is read. A mismatch answers the same `expert_not_found` as a
   * missing profile, so it cannot be used to enumerate profile ids.
   */
  userId: string;
  proposedTimezone: string;
  /** UTC instant; injected for testability. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * If the expert re-read their saved weekly hours in `proposedTimezone`, which confirmed
 * consultations in the next {@link TIMEZONE_IMPACT_HORIZON_DAYS} days would no longer sit
 * wholly inside a window? Read-only; nothing is moved or cancelled.
 *
 * Weekly rules only — no buffers, notice, busy times or time off. Windows come from
 * `freeIntervalsInRange` with every busy source empty, so rule expansion and DST handling are
 * the resolver's own. A consultation is affected unless a single merged window contains it
 * end to end.
 */
export async function findTimezoneImpact(
  input: FindTimezoneImpactInput
): Promise<FindTimezoneImpactResult> {
  const now = input.now ?? new Date();

  const settings = await expertsRepository.findResolverSettings(input.expertProfileId);
  if (settings === null || settings.userId !== input.userId) {
    return { outcome: 'expert_not_found' };
  }

  const horizonEnd = new Date(now.getTime() + TIMEZONE_IMPACT_HORIZON_DAYS * DAY_MS);
  const [ruleRows, consultations, upcomingTimeOff] = await Promise.all([
    availabilityRulesRepository.listByExpertProfileId(input.expertProfileId),
    consultationsRepository.listConfirmedInRange(input.expertProfileId, now, horizonEnd),
    availabilityOverridesRepository.listUpcoming(input.expertProfileId),
  ]);

  const [firstTimeOff] = upcomingTimeOff;
  const nextTimeOff =
    firstTimeOff === undefined
      ? null
      : { startDate: firstTimeOff.startDate, endDate: firstTimeOff.endDate };
  const timezone = input.proposedTimezone;

  if (consultations.length === 0) {
    return {
      outcome: 'ok',
      timezone,
      affectedCount: 0,
      truncated: false,
      affected: [],
      nextTimeOff,
    };
  }

  const startTimes = consultations.map((c) => c.startAt.getTime());
  const endTimes = consultations.map((c) => c.endAt.getTime());
  const windows = freeIntervalsInRange({
    rules: toResolverRules(ruleRows),
    baloConsultations: [],
    busyBlocks: [],
    overrideBlocks: [],
    timezone,
    rangeStart: new Date(Math.min(...startTimes)),
    rangeEnd: new Date(Math.max(...endTimes)),
    bufferBeforeMs: 0,
    bufferAfterMs: 0,
  });

  const affectedRows = consultations
    .filter(
      (c) =>
        !windows.some(
          (w) =>
            w.startAt.getTime() <= c.startAt.getTime() && w.endAt.getTime() >= c.endAt.getTime()
        )
    )
    .sort((a, b) => {
      const byStart = a.startAt.getTime() - b.startAt.getTime();
      return byStart === 0 ? a.id.localeCompare(b.id) : byStart;
    });

  const affectedCount = affectedRows.length;
  if (affectedCount === 0) {
    return {
      outcome: 'ok',
      timezone,
      affectedCount: 0,
      truncated: false,
      affected: [],
      nextTimeOff,
    };
  }

  const detailRows = affectedRows.slice(0, TIMEZONE_IMPACT_DETAIL_LIMIT);
  const companiesByMeetingId = await resolveClientCompaniesForMeetings(
    detailRows.map((row) => row.meetingId),
    input.expertProfileId
  );

  const affected: TimezoneImpactDetail[] = detailRows.map((row) => {
    const company = companiesByMeetingId.get(row.meetingId);
    if (company === undefined) {
      log.warn(
        { expertProfileId: input.expertProfileId, meetingId: row.meetingId },
        'Affected consultation has no resolvable client company (contexts unresolvable, ambiguous, or absent)'
      );
    }
    return {
      consultationId: row.id,
      startAt: row.startAt,
      endAt: row.endAt,
      clientCompanyName: company?.companyName ?? null,
    };
  });

  return {
    outcome: 'ok',
    timezone,
    affectedCount,
    truncated: affectedCount > TIMEZONE_IMPACT_DETAIL_LIMIT,
    affected,
    nextTimeOff,
  };
}
