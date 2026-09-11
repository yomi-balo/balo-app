import type { AdminAlert, AdminAlertKindCount, AdminSweepTick } from '@balo/db';
import {
  ADMIN_ALERT_GROUPS,
  ADMIN_ALERT_GROUP_ORDER,
  ADMIN_ALERT_CADENCES,
  ADMIN_ALERT_AGE_EMPHASIS_DAYS,
  ADMIN_ALERT_KIND_KEYS,
  ADMIN_ALERT_KINDS,
  isNoteCloseableKind,
  resolveAdminAlertKind,
  stormKindFor,
  type AdminAlertTileGroup,
  type AdminAlertGroup,
  type AdminAlertCadence,
  type AdminAlertMoney,
  type AdminAlertTarget,
} from '@balo/shared/admin-alerts';
import type { AdminAlertAgeBucket } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime

/**
 * BAL-548 / ADR-1055 — the PURE view-model layer for the admin Home queue.
 *
 * NO `server-only`, NO runtime `@balo/db` import (`AdminAlert` / `AdminAlertKindCount` /
 * `AdminSweepTick` are `import type` only — erased at compile, the `promo-codes-view.ts`
 * precedent), NO I/O. `buildAdminQueueView` folds three already-fetched reads into a fully
 * serialisable DTO (ISO strings, no `Date`) — shared by `page.tsx` (the first page) and
 * `load-more-admin-alerts.ts` (every subsequent page), so fee concealment and copy can never
 * diverge between the two.
 *
 * 🚩 THE MONEY BLOCK IS A SERVER-SIDE STRIP, NOT A RENDER GATE (ADR-1029 fee-concealment
 * invariant, "relaxed on the admin serializer and nowhere else"). `buildAdminQueueRow` OMITS
 * `expert` / `margin` / `markup` from the row's `money` view entirely when `canSeeFees` is
 * false — never ships them and hides them client-side. A Server Component's props land in the
 * RSC payload regardless of any `{cap && …}` gate downstream, so the strip has to happen here.
 */

// ── DTOs ─────────────────────────────────────────────────────────────────

/** `AdminAlertMoney` with the concealable fields already stripped when `canSeeFees` is false. */
export interface AdminQueueMoneyView {
  readonly client: string;
  /** `null` ⇔ concealed (viewer lacks `MANAGE_PLATFORM_FEES`). */
  readonly expert: string | null;
  readonly margin: string | null;
  readonly markup: string | null;
  readonly extra?: readonly [string, string];
}

export interface AdminQueueCursor {
  readonly firstSeenAtIso: string;
  readonly id: string;
}

export interface AdminQueueRowView {
  readonly id: string;
  readonly kind: string;
  readonly group: AdminAlertGroup;
  /** `admin_alerts.entity_type` — drives the entity icon; presentational only. */
  readonly entityType: string;
  readonly title: string;
  readonly entityLabel: string;
  /** "Priya Nair" from "Priya Nair @ CloudPeak" — the warm CTA's short form. */
  readonly entityHead: string;
  readonly evidence: string;
  readonly facts: readonly (readonly [string, string])[];
  /** `null` when the kind carries no money (most kinds) OR the row's `detail` has none. */
  readonly money: AdminQueueMoneyView | null;
  /** True when `money !== null` and at least one field was stripped for this viewer. */
  readonly moneyConcealed: boolean;
  readonly occurrences: number;
  readonly firstSeenAtIso: string;
  readonly ageLabel: string;
  readonly ageDays: number;
  readonly ageEmphasised: boolean;
  readonly closes: string;
  /** A finder kind (or a storm row) — the sweep clears it; no manual close affordance. */
  readonly selfCloses: boolean;
  /** A no-finder kind — closeable with a note, gated client-side on `RESOLVE_ADMIN_ALERTS`. */
  readonly noteCloseable: boolean;
  readonly target: AdminAlertTarget;
  readonly cursor: AdminQueueCursor;
}

export interface AdminQueueTileView {
  readonly key: AdminAlertTileGroup;
  readonly label: string;
  readonly hint: string;
  readonly count: number;
  /** `null` ⇔ "nothing open" in this group. */
  readonly oldestAgeLabel: string | null;
  readonly active: boolean;
}

export interface AdminQueueSweepTickView {
  readonly cadence: AdminAlertCadence;
  readonly ageLabel: string;
  readonly stale: boolean;
}

export interface AdminQueueSweepDisclosure {
  /** "swept 12s ago" (the freshest tick) or "sweep hasn't run yet" (no ticks at all). */
  readonly summary: string;
  /** "1m · 12s ago · 5m · 2m ago · 15m · 7m ago" — every cadence, for a `title` attribute. */
  readonly detail: string;
  /** True when ANY cadence's tick is older than 3× its own period. */
  readonly stale: boolean;
  /** Present only when `stale` — "sweep behind — {cadence} last ran {age} ago". */
  readonly staleLabel: string | null;
}

export interface AdminQueueOldestView {
  readonly id: string;
  readonly age: string;
  readonly entityHead: string;
}

export interface AdminQueueView {
  readonly headerLine: string;
  /** The globally oldest OPEN row (regardless of the current filter), or `null` when empty. */
  readonly oldest: AdminQueueOldestView | null;
  readonly tiles: readonly AdminQueueTileView[];
  readonly rows: readonly AdminQueueRowView[];
  readonly hasMore: boolean;
  readonly nextCursor: AdminQueueCursor | null;
  /** Exact total open count, across every group (from `countOpenByKind`, never `rows.length`). */
  readonly totalOpenCount: number;
  readonly group: AdminAlertTileGroup | null;
  readonly groupLabel: string | null;
  readonly groupHint: string | null;
  readonly sweep: AdminQueueSweepDisclosure;
  /** True-zero: nothing open anywhere. */
  readonly isEmpty: boolean;
  /** A filter is active and it matched nothing. */
  readonly isFilteredEmpty: boolean;
  /** BAL-548 analytics (`admin_queue_viewed`'s `oldest_age_days`) — the globally-oldest open
   *  row's age in days, `0` when `oldest === null` (nothing open). Kept separate from `oldest`
   *  (which carries only the formatted `age` string) so the analytics dispatch point never has
   *  to re-derive a day count from a label. */
  readonly oldestAgeDays: number;
}

// ── Age formatting (prototype's `fmtAge`, `admin-home.jsx:1057`) ──────────

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/** `<60m → "{n}m"`, `<24h → "{n}h"`, else `"{n}d"`. Ages are facts, never countdowns. */
export function formatAdminAlertAge(ageMinutes: number): string {
  if (ageMinutes < HOUR_MINUTES) return `${Math.floor(ageMinutes)}m`;
  if (ageMinutes < DAY_MINUTES) return `${Math.round(ageMinutes / HOUR_MINUTES)}h`;
  return `${Math.round(ageMinutes / DAY_MINUTES)}d`;
}

const AGE_BUCKET_UNDER_1D = 1;
const AGE_BUCKET_1_3D = 3;
const AGE_BUCKET_3_7D = 7;

/**
 * BAL-548 analytics (`admin_alert_opened` / `admin_alert_closed`) — `ageDays` folded to the
 * coarse `AdminAlertAgeBucket` PostHog measures, never the raw day count (PII-adjacent noise —
 * see `@balo/analytics`'s `admin-alerts.ts` docblock). Boundaries mirror
 * `ADMIN_ALERT_AGE_EMPHASIS_DAYS`'s own `>=` convention: a boundary value rolls into the NEXT
 * bucket up, never the one below.
 */
export function adminAlertAgeBucket(ageDays: number): AdminAlertAgeBucket {
  if (ageDays < AGE_BUCKET_UNDER_1D) return 'under_1d';
  if (ageDays < AGE_BUCKET_1_3D) return '1_3d';
  if (ageDays < AGE_BUCKET_3_7D) return '3_7d';
  return 'over_7d';
}

function ageMinutesSince(at: Date, now: Date): number {
  return Math.max(0, (now.getTime() - at.getTime()) / MINUTE_MS);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// ── Kind → group folding ────────────────────────────────────────────────

/** Every literal kind string (base + its `.storm` derivative) belonging to one tile group. */
export function adminAlertKindsForGroupFilter(group: AdminAlertTileGroup): readonly string[] {
  const out: string[] = [];
  for (const kind of ADMIN_ALERT_KIND_KEYS) {
    if (ADMIN_ALERT_KINDS[kind].group === group) {
      out.push(kind, stormKindFor(kind));
    }
  }
  return out;
}

/** `?group=` → a known tile group, or `null` (= all). Set membership — never a bare index. */
export function parseAdminAlertGroupFilter(raw: string | undefined): AdminAlertTileGroup | null {
  if (raw === undefined) return null;
  const known = new Set<string>(ADMIN_ALERT_GROUP_ORDER);
  return known.has(raw) ? (raw as AdminAlertTileGroup) : null;
}

/**
 * A resolved kind's group, or the `'platform'` fallback for an UNRESOLVABLE kind string (a
 * kind deleted from the registry while rows are still open). Never dropped — see the module
 * docblock's "never dropped" rule.
 */
function resolveRowGroup(kind: string): AdminAlertGroup {
  return resolveAdminAlertKind(kind)?.meta.group ?? 'platform';
}

// ── Rows ─────────────────────────────────────────────────────────────────

const UNRESOLVED_KIND_TARGET: AdminAlertTarget = { label: 'the queue', href: '/admin' };
const UNRESOLVED_KIND_CLOSES = 'Closes with a note';

function stripMoney(money: AdminAlertMoney, canSeeFees: boolean): AdminQueueMoneyView {
  if (canSeeFees) {
    return {
      client: money.client,
      expert: money.expert,
      margin: money.margin,
      markup: money.markup,
      extra: money.extra,
    };
  }
  // 🚩 THE STRIP. `expert` / `margin` / `markup` never enter the object at all — there is no
  // downstream conditional that could accidentally re-expose them from this point on.
  return {
    client: money.client,
    expert: null,
    margin: null,
    markup: null,
    extra: money.extra,
  };
}

/**
 * One row's full view — the SINGLE per-row mapping, exported so `load-more-admin-alerts.ts`
 * maps its keyset page through the exact same function `buildAdminQueueView` uses for the
 * first page. That is what makes fee concealment (and every other derived field) structurally
 * unable to diverge between the first page and the rest.
 */
export function buildAdminQueueRow(
  alert: AdminAlert,
  input: { readonly canSeeFees: boolean; readonly now: Date }
): AdminQueueRowView {
  const resolved = resolveAdminAlertKind(alert.kind);
  const firstSeenAt = toDate(alert.firstSeenAt);
  const ageMinutes = ageMinutesSince(firstSeenAt, input.now);
  const ageDays = ageMinutes / DAY_MINUTES;
  const entityLabel = alert.detail.entityLabel;
  // The prototype's rule (`admin-home.jsx:1773`), computed once here so the page and the
  // warm-CTA link never re-derive it differently.
  const entityHead = entityLabel.split(' @')[0]?.split(' ·')[0] ?? entityLabel;
  const money = alert.detail.money;

  const group = resolved?.meta.group ?? 'platform';
  const selfCloses = resolved === null ? false : resolved.meta.finder !== null;
  const closes = resolved?.meta.closes ?? UNRESOLVED_KIND_CLOSES;
  const target = resolved?.meta.target({ entityId: alert.entityId, detail: alert.detail }) ?? {
    ...UNRESOLVED_KIND_TARGET,
  };

  return {
    id: alert.id,
    kind: alert.kind,
    group,
    entityType: alert.entityType,
    title: alert.detail.title,
    entityLabel,
    entityHead,
    evidence: alert.detail.evidence,
    facts: alert.detail.facts,
    money: money === undefined ? null : stripMoney(money, input.canSeeFees),
    moneyConcealed: money !== undefined && !input.canSeeFees,
    occurrences: alert.occurrences,
    firstSeenAtIso: toIso(alert.firstSeenAt),
    ageLabel: formatAdminAlertAge(ageMinutes),
    ageDays,
    ageEmphasised: ageDays >= ADMIN_ALERT_AGE_EMPHASIS_DAYS,
    closes,
    selfCloses,
    // ⚠ Derived from the SAME registry predicate the close action's `noteCloseableKinds`
    // uses (`isNoteCloseableKind`) — never the inverse of `selfCloses`, because a storm kind
    // has `selfCloses === true` (its base has a finder) but is also correctly excluded here
    // (its literal `<base>.storm` string is never in `NOTE_CLOSEABLE_KINDS`).
    noteCloseable: isNoteCloseableKind(alert.kind),
    target,
    cursor: { firstSeenAtIso: toIso(alert.firstSeenAt), id: alert.id },
  };
}

// ── Tiles ────────────────────────────────────────────────────────────────

function buildTiles(input: {
  readonly counts: readonly AdminAlertKindCount[];
  readonly activeGroup: AdminAlertTileGroup | null;
  readonly now: Date;
}): readonly AdminQueueTileView[] {
  return ADMIN_ALERT_GROUP_ORDER.map((key) => {
    const meta = ADMIN_ALERT_GROUPS[key];
    let count = 0;
    let oldest: Date | null = null;
    for (const row of input.counts) {
      if (resolveRowGroup(row.kind) !== key) continue;
      count += row.count;
      const rowOldest = toDate(row.oldestFirstSeenAt);
      if (oldest === null || rowOldest < oldest) oldest = rowOldest;
    }
    return {
      key,
      label: meta.label,
      hint: meta.hint,
      count,
      oldestAgeLabel:
        oldest === null ? null : formatAdminAlertAge(ageMinutesSince(oldest, input.now)),
      active: input.activeGroup === key,
    };
  });
}

// ── Sweep disclosure ────────────────────────────────────────────────────

/** The sweep's own cadence period, in minutes — for the "3× its own period" staleness rule. */
const CADENCE_PERIOD_MINUTES: Readonly<Record<AdminAlertCadence, number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
};

const STALE_MULTIPLIER = 3;

function buildSweepDisclosure(
  ticks: readonly AdminSweepTick[],
  now: Date
): AdminQueueSweepDisclosure {
  if (ticks.length === 0) {
    return {
      summary: "sweep hasn't run yet",
      detail: "sweep hasn't run yet",
      stale: false,
      staleLabel: null,
    };
  }

  const views: AdminQueueSweepTickView[] = ADMIN_ALERT_CADENCES.map((cadence) => {
    const tick = ticks.find((t) => t.cadence === cadence);
    if (tick === undefined) {
      return { cadence, ageLabel: 'never', stale: false };
    }
    const ageMinutes = ageMinutesSince(toDate(tick.lastTickAt), now);
    const period = CADENCE_PERIOD_MINUTES[cadence];
    return {
      cadence,
      ageLabel: `${formatAdminAlertAge(ageMinutes)} ago`,
      stale: ageMinutes > STALE_MULTIPLIER * period,
    };
  });

  // The FRESHEST tick among the ones that have ever run, for the one-line summary.
  const withTicks = ticks
    .map((t) => ({ cadence: t.cadence, at: toDate(t.lastTickAt) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const [freshest] = withTicks;
  const summary =
    freshest === undefined
      ? "sweep hasn't run yet"
      : `swept ${formatAdminAlertAge(ageMinutesSince(freshest.at, now))} ago`;

  const detail = views.map((v) => `${v.cadence} · ${v.ageLabel}`).join(' · ');
  const staleView = views.find((v) => v.stale);
  const staleLabel =
    staleView === undefined
      ? null
      : `sweep behind — ${staleView.cadence} last ran ${staleView.ageLabel}`;

  return { summary, detail, stale: staleView !== undefined, staleLabel };
}

// ── The builder ──────────────────────────────────────────────────────────

export interface BuildAdminQueueViewInput {
  readonly counts: readonly AdminAlertKindCount[];
  /** The rows to RENDER — already filtered by `group` at the repository call site. */
  readonly page: { readonly alerts: readonly AdminAlert[]; readonly hasMore: boolean };
  /**
   * The globally-oldest open row, fetched UNFILTERED — needed for the header/warm-CTA even
   * when `group` narrows `page`. `null` when the caller skipped the extra read because `page`
   * already IS the unfiltered oldest-first set (`group === null`).
   */
  readonly globalOldest: AdminAlert | null;
  readonly ticks: readonly AdminSweepTick[];
  readonly canSeeFees: boolean;
  readonly group: AdminAlertTileGroup | null;
  readonly now: Date;
}

/** The keyset cursor for "load more from here" — the last row's `(firstSeenAt, id)`, or `null`
 *  when there is nothing further. Shared by the page and `load-more-admin-alerts.ts`. */
export function nextAdminQueueCursor(
  rows: readonly AdminQueueRowView[],
  hasMore: boolean
): AdminQueueCursor | null {
  const lastRow = rows[rows.length - 1];
  return hasMore && lastRow !== undefined ? lastRow.cursor : null;
}

export function buildAdminQueueView(input: BuildAdminQueueViewInput): AdminQueueView {
  const { counts, page, ticks, canSeeFees, group, now } = input;

  const totalOpenCount = counts.reduce((sum, row) => sum + row.count, 0);
  const manualCount = counts.reduce(
    (sum, row) => sum + (isNoteCloseableKind(row.kind) ? row.count : 0),
    0
  );

  const oldestAlert = group === null ? (page.alerts[0] ?? null) : input.globalOldest;
  const oldestRow =
    oldestAlert === null ? null : buildAdminQueueRow(oldestAlert, { canSeeFees, now });
  const oldest: AdminQueueOldestView | null =
    oldestRow === null
      ? null
      : { id: oldestRow.id, age: oldestRow.ageLabel, entityHead: oldestRow.entityHead };

  const headerLine =
    totalOpenCount === 0
      ? '0 open'
      : `${totalOpenCount} open · ${manualCount} close with a note · oldest waiting ${oldest?.age ?? '—'}`;

  const rows = page.alerts.map((alert) => buildAdminQueueRow(alert, { canSeeFees, now }));
  const nextCursor = nextAdminQueueCursor(rows, page.hasMore);

  const tiles = buildTiles({ counts, activeGroup: group, now });
  const groupMeta = group === null ? null : ADMIN_ALERT_GROUPS[group];

  return {
    headerLine,
    oldest,
    tiles,
    rows,
    hasMore: page.hasMore,
    nextCursor,
    totalOpenCount,
    group,
    groupLabel: groupMeta?.label ?? null,
    groupHint: groupMeta?.hint ?? null,
    sweep: buildSweepDisclosure(ticks, now),
    isEmpty: totalOpenCount === 0,
    isFilteredEmpty: group !== null && rows.length === 0,
    oldestAgeDays: oldestRow?.ageDays ?? 0,
  };
}
