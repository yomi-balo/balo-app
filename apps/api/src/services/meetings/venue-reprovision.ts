import { meetingsRepository, type NonTargetLiveVenue, type ScheduledVenueTarget } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { isDailyDomainLabel, MISSED_CALL_TERMINATION_MS } from '@balo/shared/meetings';

/**
 * BAL-518 — forced re-provision of call venues stamped on a Daily domain being retired.
 *
 * Nulls the venue of FUTURE `scheduled` meetings whose `join_url` is on the old domain; the venue
 * repair job (`venue-repair-schedule.ts`) then re-creates each room on the domain the API key now
 * points at. Room names are a pure function of the meeting id, so the same name is re-created.
 * Invites and emails carry Balo's `/meetings/{id}/call`, never the Daily URL, so nothing is re-sent.
 *
 * Every other live meeting on the old domain falls in one of two classes, split on
 * `cutoff = now − MISSED_CALL_TERMINATION_MS`:
 *
 *   - BLOCKER — can still legitimately start or run: a `scheduled` meeting that started after the
 *     cutoff (inside its missed-call window), or a `waiting_for_participants` / `in_progress`
 *     meeting whose `scheduled_end` is after the cutoff. Nulling its venue would turn a joinable
 *     call into `venue_unavailable`, so it is reported and left alone, and it gates the script.
 *   - STRANDED — can no longer start or run: a `scheduled` meeting that started at or before the
 *     cutoff (the lifecycle sweep terminates it as a missed call), or a live-status meeting whose
 *     `scheduled_end` is at or before the cutoff. Reported with its id, never gating: the
 *     `meeting.stranded` admin alert (BAL-586) owns getting it ended, and a row that has been
 *     stuck for days must not hold the cutover hostage.
 *
 * The cutoff uses the shipped default timer, not the `MEETING_MISSED_CALL_MINUTES` override (the
 * script runs without the API's environment).
 *
 * Run by `scripts/daily-venue-reprovision.ts`; DB-only, no Daily call.
 */

const log = createLogger('venue-reprovision');

/** Hard bound on each read when the caller gives none. */
export const DEFAULT_LIMIT = 500;
const DAILY_HOST_SUFFIX = '.daily.co';
const SUPABASE_POOLER_HOST_SUFFIX = '.pooler.supabase.com';
const SUPABASE_DIRECT_HOST_PREFIX = 'db.';
const SUPABASE_DIRECT_HOST_SUFFIX = '.supabase.co';
const SUPABASE_POOLER_USER_PREFIX = 'postgres.';
const PROJECT_REF_NOT_AVAILABLE = '(project ref: n/a)';

/**
 * `'getbalo'` or `'getbalo.daily.co'` → `'https://getbalo.daily.co/'`. The trailing slash is part
 * of the prefix, so `https://getbalo.daily.co.evil/…` can never match. Anything else throws.
 */
export function joinUrlPrefixForDomain(domain: string): string {
  const label = domain.endsWith(DAILY_HOST_SUFFIX)
    ? domain.slice(0, -DAILY_HOST_SUFFIX.length)
    : domain;
  if (!isDailyDomainLabel(label)) {
    throw new Error(
      'Daily domain must be a single [a-z0-9-] label, optionally ending in .daily.co'
    );
  }
  return `https://${label}${DAILY_HOST_SUFFIX}/`;
}

/** A Supabase project ref: non-empty lowercase letters and digits. */
function isProjectRef(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    const isLower = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    if (!isLower && !isDigit) return false;
  }
  return true;
}

/**
 * The Supabase project ref a database url targets, or `null` when it is not recognisably one.
 *
 * The Supavisor pooler host (`aws-0-<region>.pooler.supabase.com`) is shared by every project, so
 * there the ref is the username `postgres.<ref>`; a direct host is `db.<ref>.supabase.co`. A value
 * is returned only if it is purely `[a-z0-9]`, so an unexpected username can never be echoed.
 */
function supabaseProjectRef(url: URL): string | null {
  const host = url.hostname;
  if (host.endsWith(SUPABASE_POOLER_HOST_SUFFIX)) {
    if (!url.username.startsWith(SUPABASE_POOLER_USER_PREFIX)) return null;
    const ref = url.username.slice(SUPABASE_POOLER_USER_PREFIX.length);
    return isProjectRef(ref) ? ref : null;
  }
  if (host.startsWith(SUPABASE_DIRECT_HOST_PREFIX) && host.endsWith(SUPABASE_DIRECT_HOST_SUFFIX)) {
    const ref = host.slice(SUPABASE_DIRECT_HOST_PREFIX.length, -SUPABASE_DIRECT_HOST_SUFFIX.length);
    return isProjectRef(ref) ? ref : null;
  }
  return null;
}

/**
 * The target of a database url, for an operator to confirm: `<host[:port]> (project ref: <ref>)`.
 * The ref is what tells two Supabase projects apart behind the shared pooler host; a non-Supabase
 * url prints `(project ref: n/a)`. Never the password, other credentials, path or query; an
 * unparseable value prints as a placeholder, never itself.
 */
export function describeDatabaseHost(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return '[unparseable DATABASE_URL]';
  }
  const ref = supabaseProjectRef(url);
  return `${url.host} ${ref === null ? PROJECT_REF_NOT_AVAILABLE : `(project ref: ${ref})`}`;
}

export interface BlockerClassification {
  /** Can still legitimately start or run: gates the cutover. */
  blockers: NonTargetLiveVenue[];
  /** Can no longer start or run: reported, never gating. */
  stranded: NonTargetLiveVenue[];
}

/**
 * Splits the non-target live rows into {@link BlockerClassification}. A `scheduled` row is judged
 * on `scheduled_start`, any other live row on `scheduled_end`, both against `now − missedCallMs`.
 */
export function classifyNonTargets(
  rows: readonly NonTargetLiveVenue[],
  now: Date,
  missedCallTerminationMs: number = MISSED_CALL_TERMINATION_MS
): BlockerClassification {
  const cutoffMs = now.getTime() - missedCallTerminationMs;
  const blockers: NonTargetLiveVenue[] = [];
  const stranded: NonTargetLiveVenue[] = [];
  for (const row of rows) {
    const clock = row.status === 'scheduled' ? row.scheduledStart : row.scheduledEnd;
    if (clock.getTime() <= cutoffMs) {
      stranded.push(row);
    } else {
      blockers.push(row);
    }
  }
  return { blockers, stranded };
}

export interface VenueReprovisionInput {
  fromDomain: string;
  apply: boolean;
  now: Date;
  /** Hard bound on each read. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
  /** Defaults to the shipped {@link MISSED_CALL_TERMINATION_MS}. */
  missedCallTerminationMs?: number;
}

export interface VenueReprovisionReport {
  joinUrlPrefix: string;
  targets: ScheduledVenueTarget[];
  blockers: NonTargetLiveVenue[];
  stranded: NonTargetLiveVenue[];
  /** The target read returned `limit` rows, so more may remain: run again. */
  targetsBatchFilled: boolean;
  /** The non-target read returned `limit` rows, so the oldest stranded rows may be unreported; every blocker is read before any stranded row. */
  nonTargetsBatchFilled: boolean;
  /** Ids actually cleared; `null` on a dry run. */
  cleared: string[] | null;
  /** Targets that were not cleared because they changed between the read and the write. */
  skipped: string[];
}

export interface VenueReprovisionDeps {
  repo: Pick<
    typeof meetingsRepository,
    | 'listScheduledVenueTargetsOnDomain'
    | 'listNonTargetLiveVenuesOnDomain'
    | 'clearScheduledVenuesOnDomain'
  >;
}

export async function runVenueReprovision(
  input: VenueReprovisionInput,
  deps: VenueReprovisionDeps = { repo: meetingsRepository }
): Promise<VenueReprovisionReport> {
  const joinUrlPrefix = joinUrlPrefixForDomain(input.fromDomain);
  const limit = input.limit ?? DEFAULT_LIMIT;

  const [targets, nonTargets] = await Promise.all([
    deps.repo.listScheduledVenueTargetsOnDomain({
      joinUrlPrefix,
      scheduledStartAfter: input.now,
      limit,
    }),
    deps.repo.listNonTargetLiveVenuesOnDomain({
      joinUrlPrefix,
      scheduledStartAtOrBefore: input.now,
      limit,
    }),
  ]);
  const targetsBatchFilled = targets.length >= limit;
  const nonTargetsBatchFilled = nonTargets.length >= limit;
  if (targetsBatchFilled) {
    log.warn(
      { fromDomain: input.fromDomain, limit },
      'venue reprovision target read hit its limit; run again'
    );
  }
  if (nonTargetsBatchFilled) {
    log.warn(
      { fromDomain: input.fromDomain, limit },
      'venue reprovision blocker read hit its limit; the oldest stranded meetings may be unreported'
    );
  }

  const { blockers, stranded } = classifyNonTargets(
    nonTargets,
    input.now,
    input.missedCallTerminationMs
  );
  if (stranded.length > 0) {
    log.warn(
      { fromDomain: input.fromDomain, stranded: stranded.length },
      'stranded meetings remain on the old Daily domain; the meeting.stranded alert owns them'
    );
  }

  const base = {
    joinUrlPrefix,
    targets,
    blockers,
    stranded,
    targetsBatchFilled,
    nonTargetsBatchFilled,
  };
  if (!input.apply) {
    return { ...base, cleared: null, skipped: [] };
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

  return { ...base, cleared, skipped };
}
