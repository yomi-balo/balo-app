/**
 * BAL-134 (D8) — THE **ONLY** PLACE THE FIVE MEETING TIMERS ARE READ FROM `process.env`.
 *
 * ⚠⚠ WHY IT IS HERE AND NOT IN `@balo/shared/meetings`. That subpath is DELIBERATELY
 * CLIENT-REACHABLE — BAL-403's in-session panel imports `computeMeetingClocks` from it
 * precisely to avoid the `@balo/db` client-bundle footgun — so a `process.env` read there
 * would ship into a browser bundle. The shared module holds typed DEFAULTS and pure rules that
 * take the timers as a parameter; this module is the boundary that turns environment into one
 * of those values. **Only `apps/api` imports it.**
 *
 * ⚠ AND THE BROWSER STILL NEVER SEES A THRESHOLD, overridden or not. The waiting phase is
 * computed server-side and sent as a LABEL (`GET /meetings/:meetingId/state`), which is what
 * makes "all timing is server-authoritative; the client renders a mirror" literally true and
 * structurally prevents drift between an overridden server and a default-carrying bundle.
 *
 * ⚠ EVERY OVERRIDE IS OPTIONAL AND EVERY FAILURE FALLS BACK TO THE SHIPPED DEFAULT. A
 * malformed Railway variable must not crash-loop the API, and it must not silently disarm an
 * alert either — so each rejection logs at `warn` with the offending variable named, and each
 * accepted override logs at `info`. `.env.example` documents all five with their defaults.
 *
 * ⚠ THE VALUES ARE READ AT CALL TIME, NOT AT IMPORT TIME. A module-level read would freeze the
 * configuration before a test could set it, and would make merely importing this module
 * environment-dependent — the same reasoning `services/daily/client.ts` records for
 * `getDailyApiKey`. Callers that want a stable set (the sweep) resolve once per tick.
 */
import {
  DEFAULT_MEETING_TIMERS,
  meetingTimersAreCoherent,
  type MeetingTimers,
} from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('meeting-timers-config');

const MS_PER_MINUTE = 60_000;

/**
 * The five env variables, as DATA — the CLAUDE.md data-driven rule applied to configuration.
 *
 * ⚠ ONE ROW PER TIMER, and the row names both the variable and the field it overrides. Five
 * copy-pasted `parseInt(process.env.X)` blocks would be exactly the shape SonarCloud's
 * duplication gate flags, and would make it possible to wire a variable to the wrong field
 * without anything failing.
 */
const TIMER_OVERRIDES: ReadonlyArray<{
  readonly field: keyof MeetingTimers;
  readonly variable: string;
}> = [
  { field: 'expertAbsentAlertMs', variable: 'MEETING_EXPERT_ABSENT_ALERT_MINUTES' },
  { field: 'missedCallTerminationMs', variable: 'MEETING_MISSED_CALL_MINUTES' },
  { field: 'clientAbsentNudgeMs', variable: 'MEETING_CLIENT_ABSENT_NUDGE_MINUTES' },
  { field: 'noShowFloorMs', variable: 'MEETING_NO_SHOW_FLOOR_MINUTES' },
  { field: 'idleEndEmptyMs', variable: 'MEETING_IDLE_END_MINUTES' },
];

/**
 * A positive, finite number of MINUTES, or `null`.
 *
 * ⚠ `Number(...)` RATHER THAN `parseInt(...)`, deliberately: `parseInt('5x')` is `5`, so a
 * typo would be accepted as a silently different number. `Number('5x')` is `NaN` and is
 * refused. A blank string is treated as ABSENT (Railway writes empty strings for unset
 * variables in some flows), not as zero — `Number('')` is `0`, which would otherwise disarm a
 * timer completely.
 */
function parseMinutes(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return minutes;
}

/**
 * The five timers, with any valid env overrides applied.
 *
 * ⚠ COHERENCE IS CHECKED ON THE WHOLE SET, AND A VIOLATION DISCARDS **ALL** OVERRIDES rather
 * than the offending one. An alert must fire strictly before the termination it exists to
 * prevent; a partial application could leave, say, a 20-minute alert against a 10-minute
 * missed-call termination — i.e. Balo told "nobody turned up" only after already closing the
 * meeting, with a zero-second salvage window. Falling back wholesale is the only outcome that
 * is guaranteed sane, and it is loud (`log.error`).
 */
export function resolveMeetingTimers(): MeetingTimers {
  const resolved: Record<keyof MeetingTimers, number> = { ...DEFAULT_MEETING_TIMERS };
  const applied: Record<string, number> = {};

  for (const { field, variable } of TIMER_OVERRIDES) {
    const raw = process.env[variable];
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    const minutes = parseMinutes(raw);
    if (minutes === null) {
      // ⚠ THE VARIABLE NAME, NEVER THE RAW VALUE'S SEMANTICS — it is a duration, not a secret,
      // but naming the variable is what makes the misconfiguration actionable.
      log.warn(
        { variable, defaultMs: DEFAULT_MEETING_TIMERS[field] },
        'Meeting timer override is not a positive number of minutes — using the default'
      );
      continue;
    }
    resolved[field] = minutes * MS_PER_MINUTE;
    applied[variable] = minutes;
  }

  if (!meetingTimersAreCoherent(resolved)) {
    log.error(
      { applied },
      'Meeting timer overrides are INCOHERENT (an alert would fire at or after the termination it exists to prevent) — discarding ALL overrides'
    );
    return DEFAULT_MEETING_TIMERS;
  }

  if (Object.keys(applied).length > 0) {
    log.info({ applied }, 'Meeting timer overrides applied');
  }
  return resolved;
}
