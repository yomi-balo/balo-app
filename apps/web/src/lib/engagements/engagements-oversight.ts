import 'server-only';

import { AUTO_ACCEPT_DAYS, engagementsRepository } from '@balo/db';
import {
  deriveOversightCounts,
  deriveOversightRow,
  type EngagementsOversightDTO,
} from './oversight-row';

/**
 * engagements-oversight — the `server-only` loader for the admin engagements
 * oversight list (BAL-335). Reads EVERY non-deleted engagement (all statuses,
 * with parties + milestone progress) via `listAllWithProgress`, folds each item
 * through the pure derivers in `oversight-row.ts`, and returns a fully
 * serialisable DTO (ISO strings + precomputed labels + booleans — no `Date`
 * crosses the RSC boundary). `AUTO_ACCEPT_DAYS` is a value import here (this
 * module never reaches a client bundle) and is injected into the pure deriver so
 * `oversight-row.ts` stays free of any `@balo/db` value import.
 *
 * No try/catch — errors propagate to the page's error boundary, which owns the
 * `log.error` + rethrow.
 */
export async function loadEngagementsOversight(
  now: Date = new Date()
): Promise<EngagementsOversightDTO> {
  const items = await engagementsRepository.listAllWithProgress();
  const rows = items.map((item) =>
    deriveOversightRow(item, now, { autoAcceptDays: AUTO_ACCEPT_DAYS })
  );
  return {
    rows,
    counts: deriveOversightCounts(rows),
    isEmpty: rows.length === 0,
  };
}
