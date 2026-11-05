import { meetingsRepository, type LiveVenueOnDomain } from '@balo/db';
import { createLogger } from '@balo/shared/logging';

/**
 * BAL-518 — forced re-provision of call venues stamped on a Daily domain being retired.
 *
 * Nulls the venue of FUTURE `scheduled` meetings whose `join_url` is on the old domain; the venue
 * repair job (`venue-repair-schedule.ts`) then re-creates each room on the domain the API key now
 * points at. Room names are a pure function of the meeting id, so the same name is re-created.
 * Invites and emails carry Balo's `/meetings/{id}/call`, never the Daily URL, so nothing is re-sent.
 *
 * Only a `scheduled` meeting that has not started is cleared. Anything else on the old domain
 * (a live call, or a past-start meeting that is still joinable) is a BLOCKER: it is reported and
 * left alone, because nulling it would turn a joinable call into `venue_unavailable`.
 *
 * Run by `scripts/daily-venue-reprovision.ts`; DB-only, no Daily call.
 */

const log = createLogger('venue-reprovision');

/** Hard bound on the read when the caller gives none. */
export const DEFAULT_LIMIT = 500;
const DAILY_HOST_SUFFIX = '.daily.co';

/** One Daily subdomain label: lowercase letters, digits and hyphens. */
function isDomainLabel(label: string): boolean {
  if (label.length === 0) return false;
  for (const char of label) {
    const isLower = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    if (!isLower && !isDigit && char !== '-') return false;
  }
  return true;
}

/**
 * `'getbalo'` or `'getbalo.daily.co'` → `'https://getbalo.daily.co/'`. The trailing slash is part
 * of the prefix, so `https://getbalo.daily.co.evil/…` can never match. Anything else throws.
 */
export function joinUrlPrefixForDomain(domain: string): string {
  const label = domain.endsWith(DAILY_HOST_SUFFIX)
    ? domain.slice(0, -DAILY_HOST_SUFFIX.length)
    : domain;
  if (!isDomainLabel(label)) {
    throw new Error(
      'Daily domain must be a single [a-z0-9-] label, optionally ending in .daily.co'
    );
  }
  return `https://${label}${DAILY_HOST_SUFFIX}/`;
}

/**
 * The host (and port) of a database url, for an operator to confirm the target. Never the
 * credentials, path or query; an unparseable value prints as a placeholder, never itself.
 */
export function describeDatabaseHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).host;
  } catch {
    return '[unparseable DATABASE_URL]';
  }
}

export interface ReprovisionPartition {
  /** `scheduled` and not yet started: safe to clear. */
  targets: LiveVenueOnDomain[];
  /** Everything else on the old domain: a live call, or a past-start meeting still joinable. */
  blockers: LiveVenueOnDomain[];
}

export function partitionReprovisionCandidates(
  rows: readonly LiveVenueOnDomain[],
  now: Date
): ReprovisionPartition {
  const targets: LiveVenueOnDomain[] = [];
  const blockers: LiveVenueOnDomain[] = [];
  for (const row of rows) {
    if (row.status === 'scheduled' && row.scheduledStart.getTime() > now.getTime()) {
      targets.push(row);
    } else {
      blockers.push(row);
    }
  }
  return { targets, blockers };
}

export interface VenueReprovisionInput {
  fromDomain: string;
  apply: boolean;
  now: Date;
  /** Hard bound on the read. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
}

export interface VenueReprovisionReport {
  joinUrlPrefix: string;
  targets: LiveVenueOnDomain[];
  blockers: LiveVenueOnDomain[];
  /** The read returned `limit` rows, so more may remain: run again. */
  batchFilled: boolean;
  /** Ids actually cleared; `null` on a dry run. */
  cleared: string[] | null;
  /** Targets that were not cleared because they changed between the read and the write. */
  skipped: string[];
}

export interface VenueReprovisionDeps {
  repo: Pick<typeof meetingsRepository, 'listLiveVenuesOnDomain' | 'clearScheduledVenuesOnDomain'>;
}

export async function runVenueReprovision(
  input: VenueReprovisionInput,
  deps: VenueReprovisionDeps = { repo: meetingsRepository }
): Promise<VenueReprovisionReport> {
  const joinUrlPrefix = joinUrlPrefixForDomain(input.fromDomain);
  const limit = input.limit ?? DEFAULT_LIMIT;

  const rows = await deps.repo.listLiveVenuesOnDomain({ joinUrlPrefix, limit });
  const batchFilled = rows.length >= limit;
  if (batchFilled) {
    log.warn(
      { fromDomain: input.fromDomain, limit },
      'venue reprovision read hit its limit; run again'
    );
  }

  const { targets, blockers } = partitionReprovisionCandidates(rows, input.now);
  if (!input.apply) {
    return { joinUrlPrefix, targets, blockers, batchFilled, cleared: null, skipped: [] };
  }

  const cleared = await deps.repo.clearScheduledVenuesOnDomain({
    meetingIds: targets.map((target) => target.meetingId),
    joinUrlPrefix,
    scheduledStartAfter: input.now,
  });
  const clearedSet = new Set(cleared);
  const skipped = targets.map((target) => target.meetingId).filter((id) => !clearedSet.has(id));

  log.info(
    {
      fromDomain: input.fromDomain,
      cleared: cleared.length,
      skipped: skipped.length,
      blockers: blockers.length,
    },
    'meeting venues cleared for re-provision'
  );
  if (blockers.length > 0) {
    log.warn(
      { fromDomain: input.fromDomain, blockers: blockers.length },
      'meetings still on the old Daily domain were left in place'
    );
  }

  return { joinUrlPrefix, targets, blockers, batchFilled, cleared, skipped };
}
