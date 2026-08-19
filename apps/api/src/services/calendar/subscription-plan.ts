import type { CalendarSubscription } from '@balo/db';
import { subscriptionRowIdFromWebhookUrl } from './webhook-url.js';

/**
 * BAL-468 §8.3 — the PURE subscription plan builder. No I/O, no SDK, no DB, no clock of its
 * own (`now` is an argument). This is where the reconciliation logic lives; the executor
 * (`subscription-reconcile.ts`) is a thin I/O shell around it.
 *
 * Renewal lead: renew a subscription once it is within 72h of its vendor-reported expiry.
 * ⚠⚠ COUPLED to the monitor's `SUBSCRIPTION_EXPIRY_ALERT_MS` (48h) and asserted at module load
 * in `jobs/calendar-subscription-monitor.ts` — see that file's docblock for the full ladder
 * (`PROBE_INTERVAL_MS (1h) ≪ SUBSCRIPTION_EXPIRY_ALERT_MS (48h) < SUBSCRIPTION_RENEWAL_LEAD_MS
 * (72h) ≪ vendor TTL (7d)`).
 */
export const SUBSCRIPTION_RENEWAL_LEAD_MS = 72 * 60 * 60 * 1000;

/** ⚠ THE CALLER MUST WARN when `cappedActions > 0` — no silent caps. */
export const SUBSCRIPTION_PLAN_MAX_ACTIONS = 25;

export interface PlanCreate {
  readonly calendarId: string;
  readonly reason: 'missing' | 'renew' | 'vendor_missing' | 'forced';
  /** Non-null ⇒ this create RENEWS an existing row. The executor deletes it only AFTER the
   *  create + insert succeed — create-then-delete, never the reverse (BAL-468 §8.6). */
  readonly supersedes: { readonly rowId: string; readonly webhookSubscriptionId: string } | null;
}

export interface PlanDelete {
  readonly webhookSubscriptionId: string;
  /** `null` ⇒ a vendor-side orphan with no Balo row. */
  readonly rowId: string | null;
  readonly reason: 'superseded' | 'undesired' | 'orphan';
}

export interface PlanStamp {
  readonly rowId: string;
  readonly expiration: Date | null;
}

export interface SubscriptionPlan {
  readonly creates: readonly PlanCreate[];
  readonly deletes: readonly PlanDelete[];
  readonly stamps: readonly PlanStamp[];
  /** > 0 ⇒ the caller must warn. No silent caps. */
  readonly cappedActions: number;
}

/** The vendor's own view of one subscription, from `calendarSubscriptions.list`. */
export interface VendorSubscriptionView {
  /** = `webhookSubscriptionId`. */
  readonly id: string;
  readonly url: string;
  /** ISO 8601 string, or absent/null when the vendor reports no expiry. */
  readonly expiration?: string | null;
}

export interface BuildSubscriptionPlanInput {
  readonly desiredCalendarIds: readonly string[];
  /** Live rows for this connection, NEWEST FIRST (`listLiveByConnectionId`'s ordering IS the
   *  canonicity rule). */
  readonly baloRows: readonly CalendarSubscription[];
  readonly vendorRecords: readonly VendorSubscriptionView[];
  /** Live row ids ACROSS connections — see rule 6's docblock for why this must be global. */
  readonly knownLiveRowIds: ReadonlySet<string>;
  /** `${base}${APIROC_WEBHOOK_PATH_PREFIX}` — the exact prefix this connection's subscriptions
   *  are registered under. */
  readonly webhookUrlPrefix: string;
  readonly now: Date;
  readonly force: boolean;
}

/** Absent/unparseable ⇒ `null` — treated as "the vendor genuinely reports no expiry" and never
 *  as a reason to plan a renewal (rule 4's footnote). Exported so the executor's verification
 *  pass (`subscription-reconcile.ts`) parses a fresh vendor read the same way, rather than a
 *  second, drift-prone copy of this logic. */
export function parseVendorExpiration(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Cap `creates.length + deletes.length` at `SUBSCRIPTION_PLAN_MAX_ACTIONS`. Creates are
 * prioritised over deletes (coverage before tidiness) — because creates persist, a capped
 * connection converges over successive passes rather than starving.
 */
function capActions(
  creates: readonly PlanCreate[],
  deletes: readonly PlanDelete[]
): { creates: readonly PlanCreate[]; deletes: readonly PlanDelete[]; cappedActions: number } {
  const total = creates.length + deletes.length;
  const cappedActions = Math.max(0, total - SUBSCRIPTION_PLAN_MAX_ACTIONS);
  if (cappedActions === 0) {
    return { creates, deletes, cappedActions };
  }
  if (creates.length >= SUBSCRIPTION_PLAN_MAX_ACTIONS) {
    return { creates: creates.slice(0, SUBSCRIPTION_PLAN_MAX_ACTIONS), deletes: [], cappedActions };
  }
  return {
    creates,
    deletes: deletes.slice(0, SUBSCRIPTION_PLAN_MAX_ACTIONS - creates.length),
    cappedActions,
  };
}

function buildVendorExpirationMap(
  vendorRecords: readonly VendorSubscriptionView[]
): Map<string, Date | null> {
  const vendorExpirationById = new Map<string, Date | null>();
  for (const record of vendorRecords) {
    vendorExpirationById.set(record.id, parseVendorExpiration(record.expiration));
  }
  return vendorExpirationById;
}

// Rule 2 — every LIVE Balo row yields a stamp when the vendor still lists it. A row absent
// from the vendor's list gets no stamp at all — that absence IS "missingAtVendor", read by
// the caller as `baloRows.length - stamps.length`, never a stamp with a null expiration.
function buildStamps(
  baloRows: readonly CalendarSubscription[],
  vendorExpirationById: ReadonlyMap<string, Date | null>
): PlanStamp[] {
  const stamps: PlanStamp[] = [];
  for (const row of baloRows) {
    if (vendorExpirationById.has(row.webhookSubscriptionId)) {
      stamps.push({
        rowId: row.id,
        expiration: vendorExpirationById.get(row.webhookSubscriptionId) ?? null,
      });
    }
  }
  return stamps;
}

// Rule 3 — canonicity is DERIVED, not stored. `baloRows` arrives newest-first, so the FIRST
// row seen per calendarId is canonical; every later (older) sibling is superseded.
function partitionCanonicalAndSuperseded(baloRows: readonly CalendarSubscription[]): {
  canonicalByCalendarId: Map<string, CalendarSubscription>;
  supersededRows: CalendarSubscription[];
} {
  const canonicalByCalendarId = new Map<string, CalendarSubscription>();
  const supersededRows: CalendarSubscription[] = [];
  for (const row of baloRows) {
    if (canonicalByCalendarId.has(row.calendarId)) {
      supersededRows.push(row);
    } else {
      canonicalByCalendarId.set(row.calendarId, row);
    }
  }
  return { canonicalByCalendarId, supersededRows };
}

// Rule 4 (no canonical row at all) — a desired calendar with NO live row.
function buildCreatesForMissingCalendars(
  desiredCalendarIds: readonly string[],
  canonicalByCalendarId: ReadonlyMap<string, CalendarSubscription>
): PlanCreate[] {
  const creates: PlanCreate[] = [];
  for (const calendarId of desiredCalendarIds) {
    if (!canonicalByCalendarId.has(calendarId)) {
      creates.push({ calendarId, reason: 'missing', supersedes: null });
    }
  }
  return creates;
}

/** The reason a canonical row needs a renewing create this pass, or `null` if it doesn't. */
function canonicalRenewalReason(
  row: CalendarSubscription,
  vendorExpirationById: ReadonlyMap<string, Date | null>,
  now: Date,
  force: boolean
): PlanCreate['reason'] | null {
  const presentAtVendor = vendorExpirationById.has(row.webhookSubscriptionId);
  if (!presentAtVendor) return 'vendor_missing';

  const vendorExpiration = vendorExpirationById.get(row.webhookSubscriptionId) ?? null;
  if (
    vendorExpiration !== null &&
    vendorExpiration.getTime() <= now.getTime() + SUBSCRIPTION_RENEWAL_LEAD_MS
  ) {
    return 'renew';
  }
  return force ? 'forced' : null;
}

// Rule 4 (a canonical row exists) / Rule 5 (undesired delete).
function buildCreatesAndDeletesForCanonicalRows(
  canonicalByCalendarId: ReadonlyMap<string, CalendarSubscription>,
  desiredSet: ReadonlySet<string>,
  vendorExpirationById: ReadonlyMap<string, Date | null>,
  now: Date,
  force: boolean
): { creates: PlanCreate[]; deletes: PlanDelete[] } {
  const creates: PlanCreate[] = [];
  const deletes: PlanDelete[] = [];

  for (const [calendarId, row] of canonicalByCalendarId) {
    if (!desiredSet.has(calendarId)) {
      deletes.push({
        webhookSubscriptionId: row.webhookSubscriptionId,
        rowId: row.id,
        reason: 'undesired',
      });
      continue;
    }

    const reason = canonicalRenewalReason(row, vendorExpirationById, now, force);
    if (reason !== null) {
      creates.push({
        calendarId,
        reason,
        supersedes: { rowId: row.id, webhookSubscriptionId: row.webhookSubscriptionId },
      });
    }
  }

  return { creates, deletes };
}

// Rule 3 (continued) — every older live sibling is always a superseded delete, independent
// of whether the canonical row needed a create this pass.
function buildSupersededDeletes(supersededRows: readonly CalendarSubscription[]): PlanDelete[] {
  return supersededRows.map((row) => ({
    webhookSubscriptionId: row.webhookSubscriptionId,
    rowId: row.id,
    reason: 'superseded' as const,
  }));
}

// Rule 6 — orphans. A vendor record whose url carries Balo's prefix but whose row id is
// live NOWHERE (not just "not on this connection" — see `knownLiveRowIds`'s docblock).
function buildOrphanDeletes(
  vendorRecords: readonly VendorSubscriptionView[],
  webhookUrlPrefix: string,
  knownLiveRowIds: ReadonlySet<string>
): PlanDelete[] {
  const deletes: PlanDelete[] = [];
  for (const record of vendorRecords) {
    if (!record.url.startsWith(webhookUrlPrefix)) continue;
    const rowId = subscriptionRowIdFromWebhookUrl(record.url, webhookUrlPrefix);
    if (rowId === null) continue;
    if (knownLiveRowIds.has(rowId)) continue;
    deletes.push({ webhookSubscriptionId: record.id, rowId: null, reason: 'orphan' });
  }
  return deletes;
}

export function buildSubscriptionPlan(input: BuildSubscriptionPlanInput): SubscriptionPlan {
  const {
    desiredCalendarIds,
    baloRows,
    vendorRecords,
    knownLiveRowIds,
    webhookUrlPrefix,
    now,
    force,
  } = input;

  const vendorExpirationById = buildVendorExpirationMap(vendorRecords);
  const stamps = buildStamps(baloRows, vendorExpirationById);
  const { canonicalByCalendarId, supersededRows } = partitionCanonicalAndSuperseded(baloRows);
  const desiredSet = new Set(desiredCalendarIds);

  const missingCreates = buildCreatesForMissingCalendars(desiredCalendarIds, canonicalByCalendarId);
  const canonical = buildCreatesAndDeletesForCanonicalRows(
    canonicalByCalendarId,
    desiredSet,
    vendorExpirationById,
    now,
    force
  );
  const supersededDeletes = buildSupersededDeletes(supersededRows);
  const orphanDeletes = buildOrphanDeletes(vendorRecords, webhookUrlPrefix, knownLiveRowIds);

  const creates = [...missingCreates, ...canonical.creates];
  const deletes = [...canonical.deletes, ...supersededDeletes, ...orphanDeletes];

  const capped = capActions(creates, deletes);
  return {
    creates: capped.creates,
    deletes: capped.deletes,
    stamps,
    cappedActions: capped.cappedActions,
  };
}
