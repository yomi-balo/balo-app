import type { PromoCode, PromoRedemptionRecord } from '@balo/db';

/**
 * promo-codes-view — the PURE, client-safe view-model layer for the admin promo-code
 * surface (BAL-384). Holds the fully serialisable DTO types (ISO strings + precomputed
 * labels/booleans — no `Date` crosses the RSC boundary) and the pure derivers that fold
 * a `PromoCode` + its `PromoRedemptionRecord`s into rows, decide the DERIVED display
 * status, count the set, and group redemptions by code.
 *
 * NO runtime `@balo/db` import — the `PromoCode` / `PromoRedemptionRecord` references
 * are `import type` (erased at compile) so a `"use client"` component can import the DTO
 * types + derivers without dragging postgres-js into the browser bundle (memory
 * `reference_balo_db_client_bundle_footgun`). The `server-only` loader lives in
 * `promo-codes-admin.ts`. `now: Date` is injected everywhere so the date math is
 * deterministic in tests (run under `TZ=UTC`).
 *
 * Money is AUD integer minor units end to end: `dollarsToMinor` converts the admin's
 * dollar entry to the minor-unit integer the Server Action receives; `formatMinorAud`
 * renders a minor-unit integer back to "A$50.00". Both live here so the single
 * dollar↔minor boundary is pure and tested.
 */

/**
 * The DERIVED display status shown on the admin surface. Only `active` / `deactivated`
 * are stored; `expired` / `exhausted` / `scheduled` are computed at read time. Precedence
 * (first match wins): deactivated > expired > exhausted > scheduled > active.
 */
export type PromoDisplayStatus = 'active' | 'scheduled' | 'expired' | 'exhausted' | 'deactivated';

/** The status filter over the code list — `all` plus every derived display status. */
export type PromoStatusFilter = 'all' | PromoDisplayStatus;

/** One redemption tracking row — every field serialisable (no `Date`). */
export interface PromoRedemptionRow {
  id: string;
  /** Redeeming party (company) — a guaranteed non-null FK on the record. */
  companyName: string;
  /** "Dana Whitfield" — the individual actor; null when no human redeemer (system). */
  actorLabel: string | null;
  grantedMinor: number;
  /** "A$50.00" — the snapshotted grant at redemption time. */
  grantedLabel: string;
  /** ISO redemption timestamp (rendered viewer-local by the client). */
  redeemedAtIso: string;
}

/** One admin promo-code row — fully serialisable, ready to cross the RSC boundary. */
export interface PromoCodeAdminRow {
  id: string;
  /** Stored normalized (uppercase); rendered mono. */
  code: string;
  grantMinor: number;
  /** "A$50.00". */
  grantLabel: string;
  perCodeRedemptionCap: number;
  redeemedCount: number;
  /** cap − redeemedCount, floored at 0. */
  remaining: number;
  /** 0–100 fill for the usage Progress bar. */
  usedPct: number;
  validFromIso: string;
  validUntilIso: string;
  displayStatus: PromoDisplayStatus;
  /** True only when the derived status is `active` (redeemable at runtime — BAL-383). */
  redeemable: boolean;
  /** Redemptions grouped from the one flat `listAllRedemptions` read (no N+1). */
  redemptions: PromoRedemptionRow[];
}

/** Whole-set display-status counts — drives the stat tiles / filter. */
export interface PromoCounts {
  active: number;
  scheduled: number;
  expired: number;
  exhausted: number;
  deactivated: number;
}

/** The serialisable promo-codes admin DTO the loader returns to the page. */
export interface PromoCodesAdminDTO {
  rows: PromoCodeAdminRow[];
  counts: PromoCounts;
  isEmpty: boolean;
}

// ── Money helpers (the single dollar↔minor boundary) ─────────────────

/**
 * AUD minor-unit integer → "A$50.00". Always two fraction digits (a promo grant is a
 * precise config amount — cents matter even on whole dollars).
 */
export function formatMinorAud(minor: number): string {
  const amount = (minor / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `A$${amount}`;
}

/**
 * Dollars (admin entry) → AUD minor-unit integer. Rounds to the nearest cent so binary
 * float drift (e.g. `19.99 * 100 = 1998.9999…`) can never produce a fractional minor
 * value. The Server Action's Zod schema then validates this integer.
 */
export function dollarsToMinor(dollars: number): number {
  return Math.round(dollars * 100);
}

// ── Derivers ─────────────────────────────────────────────────────────

/** cap − redeemedCount, never negative. */
export function deriveRemaining(cap: number, redeemedCount: number): number {
  return Math.max(0, cap - redeemedCount);
}

/** 0–100 usage fill for the Progress bar (clamped; a zero cap reads 0%). */
function deriveUsedPct(cap: number, redeemedCount: number): number {
  if (cap <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((redeemedCount / cap) * 100));
}

/**
 * The derived display status. Precedence (first match wins): deactivated > expired >
 * exhausted > scheduled > active. Depends only on the `redeemed_count` column (never on
 * the redemption rows) so a code with zero redemptions still reads correctly.
 */
export function derivePromoStatus(
  row: Pick<
    PromoCode,
    'status' | 'validFrom' | 'validUntil' | 'redeemedCount' | 'perCodeRedemptionCap'
  >,
  now: Date
): PromoDisplayStatus {
  if (row.status === 'deactivated') {
    return 'deactivated';
  }
  if (now >= row.validUntil) {
    return 'expired';
  }
  if (row.redeemedCount >= row.perCodeRedemptionCap) {
    return 'exhausted';
  }
  if (now < row.validFrom) {
    return 'scheduled';
  }
  return 'active';
}

/**
 * The individual actor's display name, or null when there is no human redeemer
 * (`redeemedByUserId` is null — a hypothetical future system promo). Falls back to "A
 * teammate" when a user id exists but the name columns are blank.
 */
function deriveActorLabel(
  record: Pick<
    PromoRedemptionRecord,
    'redeemedByUserId' | 'redeemedByFirstName' | 'redeemedByLastName'
  >
): string | null {
  if (record.redeemedByUserId === null) {
    return null;
  }
  const name = [record.redeemedByFirstName, record.redeemedByLastName]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(' ')
    .trim();
  return name.length > 0 ? name : 'A teammate';
}

/** Fold one repo redemption record into a serialisable row. */
function deriveRedemptionRow(record: PromoRedemptionRecord): PromoRedemptionRow {
  return {
    id: record.id,
    companyName: record.companyName,
    actorLabel: deriveActorLabel(record),
    grantedMinor: record.grantedMinor,
    grantedLabel: formatMinorAud(record.grantedMinor),
    redeemedAtIso: record.redeemedAt.toISOString(),
  };
}

/**
 * Group a flat redemption list (newest-first from `listAllRedemptions`) by
 * `promoCodeId`, preserving order within each code. One pass, no N+1.
 */
export function groupRedemptionsByCode(
  records: ReadonlyArray<PromoRedemptionRecord>
): Map<string, PromoRedemptionRow[]> {
  const grouped = new Map<string, PromoRedemptionRow[]>();
  for (const record of records) {
    const existing = grouped.get(record.promoCodeId) ?? [];
    existing.push(deriveRedemptionRow(record));
    grouped.set(record.promoCodeId, existing);
  }
  return grouped;
}

/** Fold one promo code + its (already-grouped) redemptions into a serialisable row. */
export function derivePromoRow(
  promo: PromoCode,
  redemptions: PromoRedemptionRow[],
  now: Date
): PromoCodeAdminRow {
  const displayStatus = derivePromoStatus(promo, now);
  return {
    id: promo.id,
    code: promo.code,
    grantMinor: promo.grantMinor,
    grantLabel: formatMinorAud(promo.grantMinor),
    perCodeRedemptionCap: promo.perCodeRedemptionCap,
    redeemedCount: promo.redeemedCount,
    remaining: deriveRemaining(promo.perCodeRedemptionCap, promo.redeemedCount),
    usedPct: deriveUsedPct(promo.perCodeRedemptionCap, promo.redeemedCount),
    validFromIso: promo.validFrom.toISOString(),
    validUntilIso: promo.validUntil.toISOString(),
    displayStatus,
    redeemable: displayStatus === 'active',
    redemptions,
  };
}

/** Whole-set display-status counts from a complete row list (filter-independent). */
export function derivePromoCounts(rows: ReadonlyArray<PromoCodeAdminRow>): PromoCounts {
  return {
    active: rows.filter((r) => r.displayStatus === 'active').length,
    scheduled: rows.filter((r) => r.displayStatus === 'scheduled').length,
    expired: rows.filter((r) => r.displayStatus === 'expired').length,
    exhausted: rows.filter((r) => r.displayStatus === 'exhausted').length,
    deactivated: rows.filter((r) => r.displayStatus === 'deactivated').length,
  };
}

/** Whether a row belongs to a filter slice (`all` matches everything). */
export function promoRowMatchesFilter(row: PromoCodeAdminRow, filter: PromoStatusFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  return row.displayStatus === filter;
}

/**
 * The whole pure fold: `PromoCode[]` + flat `PromoRedemptionRecord[]` → the serialisable
 * DTO. The `server-only` loader calls this; keeping it here (pure) makes the fold
 * unit-testable without a DB.
 */
export function derivePromoCodesDTO(
  promos: ReadonlyArray<PromoCode>,
  records: ReadonlyArray<PromoRedemptionRecord>,
  now: Date
): PromoCodesAdminDTO {
  const grouped = groupRedemptionsByCode(records);
  const rows = promos.map((promo) => derivePromoRow(promo, grouped.get(promo.id) ?? [], now));
  return {
    rows,
    counts: derivePromoCounts(rows),
    isEmpty: rows.length === 0,
  };
}
