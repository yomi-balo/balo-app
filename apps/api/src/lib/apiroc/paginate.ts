import { callApiroc } from './index.js';
import { log } from './logging.js';

interface ApirocPage<T> {
  readonly data: T[];
  readonly nextPageToken?: string;
}

/**
 * BAL-396 fix round 2, Finding 2 — the page cap. `for (;;)`'s only original exit was the vendor
 * omitting `nextPageToken`; a vendor that echoed a CONSTANT (or cyclic) cursor looped forever,
 * one HTTP call per iteration, `results` growing without bound. This is NOT inert: BAL-396's own
 * `provisionConnection` → `listAllCalendars` runs this synchronously inside the OAuth callback
 * route AND inside the `concurrency: 1` health-probe worker (`jobs/calendar-health-probe.ts`) —
 * a hang here permanently wedges the platform's only proactive breakage signal. Precedent:
 * `CALENDAR_HEALTH_PROBE_BATCH_LIMIT` (`jobs/calendar-health-probe.ts`) — the repo's own
 * no-silent-caps rule, which this file previously violated three files away from where it's
 * enforced.
 *
 * ⚠ THE CALLER GETS A WARNING WHEN THIS FILLS — never a silent truncation.
 */
export const APIROC_PAGINATE_MAX_PAGES = 500;

/**
 * BAL-396 §10.2/§10.6 — the shared "paginate TO EXHAUSTION" loop (apiroc skill, Constraint 9):
 * follow `nextPageToken` until it is absent. Terminates cleanly on Microsoft's extra trailing
 * empty page (`count: 0`) — that page simply carries no `nextPageToken`, so the loop ends on
 * it like any other last page.
 *
 * One `callApiroc` PER PAGE, never one wrapping the whole loop — `fetchPage` is invoked once
 * per iteration, each inside its own `callApiroc` call, preserving the "exactly one fallible
 * SDK call per `callApiroc`" contract (`lib/apiroc/index.ts`).
 *
 * Bounded two ways (BAL-396 fix round 2, Finding 2): a hard page cap
 * (`APIROC_PAGINATE_MAX_PAGES`), and a cursor-progress check that aborts the moment the SAME
 * token is handed back twice in a row — a vendor bug this cap alone would still let run 500
 * calls deep before stopping. Both log a `warn` naming `operation` so the failure is visible
 * rather than silently truncated.
 */
export async function paginateApiroc<T>(
  operation: string,
  fetchPage: (pageToken: string | undefined) => Promise<ApirocPage<T>>
): Promise<T[]> {
  const results: T[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  for (;;) {
    const page = await callApiroc(operation, () => fetchPage(pageToken));
    results.push(...page.data);
    pageCount += 1;

    if (!page.nextPageToken) break;

    if (page.nextPageToken === pageToken) {
      log.warn({ operation, pageCount, pageToken }, 'apiroc_paginate_cursor_not_progressing');
      break;
    }

    if (pageCount >= APIROC_PAGINATE_MAX_PAGES) {
      log.warn(
        { operation, pageCount, maxPages: APIROC_PAGINATE_MAX_PAGES },
        'apiroc_paginate_max_pages_reached'
      );
      break;
    }

    pageToken = page.nextPageToken;
  }

  return results;
}
