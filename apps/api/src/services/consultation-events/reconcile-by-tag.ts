import type { Event, PaginatedResponse } from '@apiroc/unified-calendar-api-node-sdk';
import { getApirocClient, paginateApiroc } from '../../lib/apiroc/index.js';

export interface ReconcileByTagInput {
  readonly endUserAccountId: string;
  readonly calendarId: string;
  readonly baloBookingId: string;
}

/**
 * BAL-396 §5/§10.6 — `events.list` filtered by `metadataFilters`, paginated TO EXHAUSTION.
 * Ships INERT: no live caller until a future reconciliation sweep needs it.
 *
 * ⚠⚠ NEVER READS THE TAG OFF A FETCHED EVENT TO VERIFY A WRITE (apiroc skill §M3, corrected
 * 2026-08-18 against the raw capture). Microsoft returns `privateExtendedProperties: {}` on
 * `events.create` and `events.update` ONLY — a `metadataFilters` READ echoes the tag in full on
 * BOTH providers. So the surviving rule is: verify by QUERYING, never by reading a tag off a
 * WRITE response. This function relies ENTIRELY on the `metadataFilters` query to select the
 * right events, and that query already selected them correctly — it must never additionally
 * filter or assert by reading `event.privateExtendedProperties.baloBookingId` off the results,
 * which would be redundant at best and, for a caller that copied the old "never readable back"
 * claim literally, a silent drop of every Microsoft event.
 *
 * Returns the full vendor `Event` objects — reading Balo's OWN tagged consultation events is
 * the one sanctioned full-event-content read (apiroc skill, Constraint 4's second sentence);
 * availability itself must never take this path (that is `vendorBusyProvider.listBusyBlocks`,
 * BAL-396 §9's job).
 */
/**
 * The callback's explicit return type, not decoration: it names `nextPageToken` (SDK
 * `PaginatedResponse`, `lib/apiroc/paginate.ts`'s `ApirocPage`) as the evidence that this read
 * follows the vendor's cursor TO EXHAUSTION via `paginateApiroc`, rather than taking one bare
 * page — the property the invariant's Scan E shape gate checks for on every `events.list`
 * inside this directory.
 */
type ReconcilePage = Pick<PaginatedResponse<Event>, 'data' | 'nextPageToken'>;

export async function reconcileByTag(input: ReconcileByTagInput): Promise<Event[]> {
  const client = getApirocClient();
  return paginateApiroc(
    'events.list',
    (pageToken): Promise<ReconcilePage> =>
      client.events.list(input.endUserAccountId, input.calendarId, {
        metadataFilters: { baloBookingId: input.baloBookingId },
        ...(pageToken ? { pageToken } : {}),
      })
  );
}
