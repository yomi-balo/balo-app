/**
 * BAL-518 — FORCED RE-PROVISION of call venues off a retiring Daily domain. **MANUAL. NOT IN CI.**
 *
 * Nulls the room name and join url of FUTURE `scheduled` meetings whose join url is on
 * `--from-domain`. The venue repair job then re-creates each room on the domain the API's
 * `DAILY_API_KEY` points at, at its next daily or start-anchored checkpoint. Until then the
 * `meeting.unprovisioned` admin alert fires for those meetings; that is expected.
 *
 * DB only: no Daily call, so it needs `DATABASE_URL` and nothing else. Dry-run by default.
 * Prints the database HOST and Supabase PROJECT REF (never credentials) so the operator can
 * confirm the target, then counts and meeting ids, never join urls.
 *
 * Other live meetings on the old domain are left alone and split in two (cutoff = now minus the
 * missed-call window): BLOCKERS can still start or run, and the script exits 1 while any exist;
 * STRANDED meetings can no longer start or run, are listed as a warning only, and are owned by
 * the `meeting.stranded` alert (BAL-586).
 * Idempotent: cleared rows no longer match the domain prefix. When the batch is full, run again.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *
 *   `DATABASE_URL` must be the TARGET environment's database (the one the deployed API uses),
 *   kept in a git-ignored env file and loaded with dotenv, never typed on the command line and
 *   never `apps/api/.env.local`:
 *
 *   npx dotenv -e <target-env-file> -- npx tsx apps/api/scripts/daily-venue-reprovision.ts \
 *     --from-domain getbalo            # dry run
 *   ... --from-domain getbalo --apply  # clear
 *   ... --limit 200                    # smaller batch (default 500)
 *
 * ── ⚠ THIS FILE IS OUTSIDE THE APP'S TYPECHECK AND LINT SCOPE ───────────────────────────
 *
 * `scripts/` is covered by neither `pnpm typecheck` nor lint. Verify by hand after editing, from
 * the repo root:
 *
 *   npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
 *     --strict --noUncheckedIndexedAccess --skipLibCheck --esModuleInterop --types node \
 *     apps/api/scripts/daily-venue-reprovision.ts
 */
import { parseArgs } from 'node:util';
import { db, type NonTargetLiveVenue } from '@balo/db';
import {
  DEFAULT_LIMIT,
  describeDatabaseHost,
  runVenueReprovision,
  type VenueReprovisionReport,
} from '../src/services/meetings/venue-reprovision.js';

/** Thrown by `fail`; the top-level handler prints it once and sets the exit code. */
class ScriptFailure extends Error {}

function fail(what: string): never {
  throw new ScriptFailure(what);
}

/** drizzle's postgres-js driver exposes its client as `$client`; the `Database` type omits it. */
function hasClosableClient(value: unknown): value is { $client: { end: () => Promise<void> } } {
  if (typeof value !== 'object' || value === null || !('$client' in value)) return false;
  const client = value.$client;
  return typeof client === 'object' && client !== null && 'end' in client;
}

/** Closes the connection pool so the process can exit. */
async function closeDb(): Promise<void> {
  if (hasClosableClient(db)) {
    await db.$client.end();
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    return fail('--limit must be a positive integer');
  }
  return limit;
}

function printIds(label: string, ids: readonly string[]): void {
  console.log(`${label}: ${ids.length}`);
  for (const id of ids) {
    console.log(`  ${id}`);
  }
}

function printLive(label: string, rows: readonly NonTargetLiveVenue[]): void {
  console.log(`${label}: ${rows.length}`);
  for (const row of rows) {
    console.log(
      `  ${row.meetingId}  ${row.status}  start ${row.scheduledStart.toISOString()}  end ${row.scheduledEnd.toISOString()}`
    );
  }
}

function printReport(report: VenueReprovisionReport, apply: boolean): void {
  console.log(`\nDaily domain prefix: ${report.joinUrlPrefix}`);
  printIds(
    apply ? 'Targets (scheduled, not yet started)' : 'Would clear (scheduled, not yet started)',
    report.targets.map((target) => target.meetingId)
  );
  printLive('Blockers (can still start or run; gate the cutover)', report.blockers);
  printLive(
    'Stranded (can no longer start or run; warning only, see the meeting.stranded alert, BAL-586)',
    report.stranded
  );
  if (report.cleared !== null) {
    printIds('Cleared', report.cleared);
    printIds('Skipped (changed since the read)', report.skipped);
  }
  if (report.targetsBatchFilled) {
    console.log('\nThe target batch was full: more meetings may remain. Re-run.');
  }
  if (report.nonTargetsBatchFilled) {
    console.log(
      '\nThe blocker/stranded batch was full: it keeps the rows closest to now first, so the oldest stranded meetings may not be listed.'
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'from-domain': { type: 'string' },
      apply: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
  });

  const fromDomain = values['from-domain'];
  if (fromDomain === undefined || fromDomain.length === 0) {
    return fail('--from-domain <domain> is required (e.g. getbalo)');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return fail('DATABASE_URL is not set');
  }

  try {
    console.log(`Database host: ${describeDatabaseHost(databaseUrl)}`);
    const apply = values.apply === true;
    const report = await runVenueReprovision({
      fromDomain,
      apply,
      now: new Date(),
      limit: parseLimit(values.limit),
    });
    printReport(report, apply);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to clear the targets.');
    }
    if (report.stranded.length > 0) {
      console.warn(
        '\nWarning: stranded meetings remain on the old domain. They do not block the cutover.'
      );
    }
    if (report.blockers.length > 0) {
      console.error(
        '\nBlockers remain on the old domain. Wait for them to end, or resolve them, then re-run.'
      );
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
