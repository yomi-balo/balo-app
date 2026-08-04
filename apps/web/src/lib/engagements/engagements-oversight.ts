import 'server-only';

import { AUTO_ACCEPT_DAYS, projectEngagementsRepository } from '@balo/db';
import {
  deriveOversightCounts,
  deriveOversightRow,
  type EngagementsOversightDTO,
} from './oversight-row';

/**
 * engagements-oversight — the `server-only` loader for the admin engagements
 * oversight list (BAL-335). Reads EVERY non-deleted PROJECT (all delivery
 * statuses, with parties + milestone progress) via `listAllWithProgress`, folds
 * each item through the pure derivers in `oversight-row.ts`, and returns a fully
 * serialisable DTO (ISO strings + precomputed labels + booleans — no `Date`
 * crosses the RSC boundary). `AUTO_ACCEPT_DAYS` is a value import here (this
 * module never reaches a client bundle) and is injected into the pure deriver so
 * `oversight-row.ts` stays free of any `@balo/db` value import.
 *
 * ⚠ PROJECT-SCOPED (BAL-417 / D5). `listAllWithProgress` filters
 * `engagement_type = 'project'` inside the repository — this loader passes no
 * arguments and applies no filter of its own. That filter is load-bearing, not
 * tidiness: every deriver downstream is project-shaped, so a leaked Case would
 * render a fabricated "Fixed · A$0" pricing pill (`derivePricingLabel` reads
 * `pricingMethod`/`priceCents` unconditionally) and would be counted in the Active
 * and Stalled tiles. Do not re-point this at a type-agnostic supertype read.
 *
 * No try/catch — errors propagate to the page's error boundary, which owns the
 * `log.error` + rethrow.
 */
export async function loadEngagementsOversight(
  now: Date = new Date()
): Promise<EngagementsOversightDTO> {
  const items = await projectEngagementsRepository.listAllWithProgress();
  const rows = items.map((item) =>
    deriveOversightRow(item, now, { autoAcceptDays: AUTO_ACCEPT_DAYS })
  );
  return {
    rows,
    counts: deriveOversightCounts(rows),
    isEmpty: rows.length === 0,
  };
}
