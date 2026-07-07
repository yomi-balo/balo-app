import type { AdminEngagementListItem } from '@balo/db';
import {
  engagementActorAttribution,
  expertPartyDisplayName,
  personDisplayName,
} from '@balo/shared/parties';
import type { AdminEngagementsFilter } from '@/lib/analytics';
import { formatPostedRelative } from '@/lib/project-request/request-detail-view';
import { DAY_MS, STALLED_AFTER_DAYS } from './oversight-constants';

/**
 * oversight-row — the PURE, client-safe view-model layer for the admin
 * engagements oversight list (BAL-335). Holds the fully serialisable DTO types
 * (ISO strings + precomputed labels + booleans — no `Date` crosses the RSC
 * boundary) and the pure derivers that fold one `AdminEngagementListItem` into a
 * row, decide "stalled", match the status filters, and count the whole set.
 *
 * NO runtime `@balo/db` import — the `AdminEngagementListItem` reference is
 * `import type` (erased at compile) so a `"use client"` component can import the
 * DTO types without dragging postgres-js into the browser bundle
 * (memory `reference_balo_db_client_bundle_footgun`). The `server-only` loader
 * lives in `engagements-oversight.ts`. `now: Date` is injected everywhere so the
 * date math is deterministic in tests.
 */

/** Engagement status, sourced from the repo item (single source of truth). */
type OversightStatus = AdminEngagementListItem['status'];

/**
 * The oversight status filter — reuses the analytics event's `AdminEngagementsFilter`
 * as the single source of truth (`in_flight` is the composite active + in-review
 * default; `stalled` is a cross-cutting slice over `row.stalled`).
 */
export type OversightFilter = AdminEngagementsFilter;

/** Client-accept vs D7 auto-accept attribution for a completed engagement. */
export interface OversightAcceptance {
  method: 'client' | 'auto';
  /** "Ada Client @ Northwind" for a client accept; null on the auto path. */
  byLabel: string | null;
  /** ISO acceptance timestamp (rendered viewer-local); null if unstamped. */
  onIso: string | null;
}

/** Cancellation attribution + reason for a cancelled engagement. */
export interface OversightCancellation {
  /** "Ada Admin @ Balo" when a cancelling actor is known; null otherwise. */
  byLabel: string | null;
  /** ISO cancellation timestamp (rendered viewer-local); null if unstamped. */
  onIso: string | null;
  /** Free-text cancellation reason ('' when none was captured). */
  reason: string;
}

/**
 * One admin oversight row — every field serialisable (strings / numbers /
 * booleans, never a `Date`) so it can cross the RSC boundary to a client shell.
 */
export interface EngagementOversightRow {
  id: string;
  /** `/engagements/{id}` — the delivery detail route (D4). */
  href: string;
  status: OversightStatus;
  title: string;
  /** Client company name (party). */
  client: string;
  /** "Sam Expert @ Acme" (agency) or "Sam Expert" (independent). */
  expertLabel: string;
  /** Milestone progress; `total === 0` renders "No milestones" in the shell. */
  progress: { done: number; total: number };
  /** "Fixed · A$40,000" or "T&M · A$220.50/hr · cap A$40,000". */
  pricingLabel: string;
  /** ISO kickoff (activated) timestamp, rendered viewer-local as "Kicked off 12 Jun". */
  kickoffIso: string;
  /** Relative last-activity label, e.g. "3 days ago". */
  lastActivityRelative: string;
  /** ISO last-activity timestamp (sort key already applied server-side). */
  lastActivityIso: string;
  /** True when active/in-review and quiet for >= STALLED_AFTER_DAYS. */
  stalled: boolean;
  /** Whole days since last activity (0 when there is no activity signal). */
  quietDays: number;
  /**
   * In-review only: the ISO auto-accept timestamp, rendered viewer-local as a
   * helpful fact ("Auto-accepts 19 Jun"), NOT a countdown. Omitted when the
   * engagement is not `pending_acceptance` or has no `completionRequestedAt`.
   */
  autoAcceptIso?: string;
  /** Completed only: acceptance attribution. */
  acceptance?: OversightAcceptance;
  /** Cancelled only: cancellation attribution + reason. */
  cancellation?: OversightCancellation;
}

/** Whole-set status counts (filter-independent) — drives the stat tiles. */
export interface OversightCounts {
  active: number;
  inReview: number;
  stalled: number;
  completed: number;
  cancelled: number;
}

/** The serialisable oversight DTO the loader returns to the page. */
export interface EngagementsOversightDTO {
  rows: EngagementOversightRow[];
  counts: OversightCounts;
  isEmpty: boolean;
}

// ── Pure helpers ────────────────────────────────────────────────────
// (Absolute dates are formatted VIEWER-LOCAL in the client `<LocalDate>`; the
//  derivers pass ISO timestamps, so no date formatting happens here.)

/** A new `Date` `days` after `date` (auto-accept fact math). */
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days between two instants (floored). */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Currency-aware money label: 'aud' → `A$40,000`, else `USD 40,000`. Cents are
 * shown only when the amount is NOT a whole dollar (so whole totals stay clean but
 * a T&M rate like A$187.50/hr keeps its cents).
 */
function money(cents: number, currency: string): string {
  const prefix = currency.toLowerCase() === 'aud' ? 'A$' : `${currency.toUpperCase()} `;
  const fractionDigits = cents % 100 === 0 ? 0 : 2;
  const amount = (cents / 100).toLocaleString('en-AU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${prefix}${amount}`;
}

// ── Derivers ───────────────────────────────────────────────────────

/**
 * True when an engagement is stalled: only `active` / `pending_acceptance` are
 * eligible, it must have a real activity signal, and that signal must be
 * `STALLED_AFTER_DAYS` or more old. Completed/cancelled are never stalled; a
 * fresh kickoff (activity today) is never stalled.
 */
export function isEngagementStalled(item: AdminEngagementListItem, now: Date): boolean {
  if (item.status !== 'active' && item.status !== 'pending_acceptance') {
    return false;
  }
  if (item.lastActivityAt === null) {
    return false;
  }
  return daysBetween(item.lastActivityAt, now) >= STALLED_AFTER_DAYS;
}

/**
 * "Sam Expert @ Acme" (agency) or "Sam Expert" (independent).
 *
 * The admin oversight row deliberately shows BOTH the person and the agency for an
 * agency-based expert — richer than the `@balo/shared/parties` party/person
 * convention (which collapses to a single name). The person-only fallback still
 * defers to that shared convention (incl. its "An expert" empty-name fallback) so
 * D5 stays consistent with the D6 inbox and the D1 workspace.
 */
function deriveExpertLabel(item: AdminEngagementListItem): string {
  const { type, user, agency } = item.expertProfile;
  const agencyName = agency?.name ?? null;
  if (agencyName !== null) {
    return `${personDisplayName(user.firstName, user.lastName)} @ ${agencyName}`;
  }
  return expertPartyDisplayName({
    type,
    agencyName,
    firstName: user.firstName,
    lastName: user.lastName,
  });
}

/** "Fixed · A$40,000" or "T&M · A$220/hr · cap A$40,000". */
function derivePricingLabel(item: AdminEngagementListItem): string {
  if (item.pricingMethod === 'fixed') {
    return `Fixed · ${money(item.priceCents, item.currency)}`;
  }
  const rateCents = item.rateCents ?? 0;
  return `T&M · ${money(rateCents, item.currency)}/hr · cap ${money(item.priceCents, item.currency)}`;
}

/** The accept/cancel actor as projected by the repo (name + role, PII-safe). */
type EngagementActor = NonNullable<AdminEngagementListItem['acceptedBy']>;

/**
 * Retrospective attribution label for an accept/cancel actor on THIS engagement —
 * the affiliation ("@ Balo" / "@ {agency}" / "@ {company}") is DERIVED from the
 * actor's role + identity by `@balo/shared/parties`' `engagementActorAttribution`,
 * never hard-coded, so a future client/expert cancel path (D4) reuses the one rule.
 */
function actorLabel(item: AdminEngagementListItem, actor: EngagementActor): string {
  return engagementActorAttribution({
    actor,
    expertUserId: item.expertProfile.user.id,
    expertAgencyName: item.expertProfile.agency?.name ?? null,
    companyName: item.company.name,
  });
}

/** Completed-only acceptance attribution (actor named by affiliation, or null auto). */
function deriveAcceptance(item: AdminEngagementListItem): OversightAcceptance {
  const method = item.acceptanceMethod ?? 'auto';
  const byLabel =
    method === 'client' && item.acceptedBy !== null ? actorLabel(item, item.acceptedBy) : null;
  const onIso = item.acceptedAt === null ? null : item.acceptedAt.toISOString();
  return { method, byLabel, onIso };
}

/** Cancelled-only cancellation attribution (actor named by affiliation) + reason. */
function deriveCancellation(item: AdminEngagementListItem): OversightCancellation {
  const byLabel = item.cancelledBy === null ? null : actorLabel(item, item.cancelledBy);
  const onIso = item.cancelledAt === null ? null : item.cancelledAt.toISOString();
  return { byLabel, onIso, reason: item.cancellationReason ?? '' };
}

/** The status-specific optional fields for a row (no post-construction mutation). */
function deriveStatusExtras(
  item: AdminEngagementListItem,
  opts: { autoAcceptDays: number }
): Pick<EngagementOversightRow, 'autoAcceptIso' | 'acceptance' | 'cancellation'> {
  if (item.status === 'pending_acceptance') {
    if (item.completionRequestedAt === null) {
      return {};
    }
    return {
      autoAcceptIso: addDays(item.completionRequestedAt, opts.autoAcceptDays).toISOString(),
    };
  }
  if (item.status === 'completed') {
    return { acceptance: deriveAcceptance(item) };
  }
  if (item.status === 'cancelled') {
    return { cancellation: deriveCancellation(item) };
  }
  return {};
}

/**
 * Fold one repo item into a serialisable oversight row. `now` drives every
 * relative/stall calculation; `opts.autoAcceptDays` (the `@balo/db`
 * `AUTO_ACCEPT_DAYS`) is injected so this module never value-imports `@balo/db`.
 */
export function deriveOversightRow(
  item: AdminEngagementListItem,
  now: Date,
  opts: { autoAcceptDays: number }
): EngagementOversightRow {
  const clientName = item.company.name;
  const activityAt = item.lastActivityAt ?? item.createdAt;
  // Clamp: a completed_at/started_at a hair ahead of `now` (clock skew) must not
  // surface as a negative "Quiet -1d".
  const quietDays =
    item.lastActivityAt === null ? 0 : Math.max(0, daysBetween(item.lastActivityAt, now));

  return {
    id: item.id,
    href: `/engagements/${item.id}`,
    status: item.status,
    title: item.projectRequest?.title ?? `${clientName} engagement`,
    client: clientName,
    expertLabel: deriveExpertLabel(item),
    progress: { done: item.completedMilestones, total: item.totalMilestones },
    pricingLabel: derivePricingLabel(item),
    kickoffIso: (item.activatedAt ?? item.createdAt).toISOString(),
    lastActivityRelative: formatPostedRelative(activityAt, now),
    lastActivityIso: activityAt.toISOString(),
    stalled: isEngagementStalled(item, now),
    quietDays,
    ...deriveStatusExtras(item, opts),
  };
}

/**
 * Whether a row belongs to a filter slice. `in_flight` is the composite active +
 * in-review default; `in_review` maps to `pending_acceptance`; `stalled` is the
 * cross-cutting slice (a quiet in-review row appears under both In review and
 * Stalled).
 */
export function oversightRowMatchesFilter(
  row: EngagementOversightRow,
  filter: OversightFilter
): boolean {
  switch (filter) {
    case 'in_flight':
      return row.status === 'active' || row.status === 'pending_acceptance';
    case 'active':
      return row.status === 'active';
    case 'in_review':
      return row.status === 'pending_acceptance';
    case 'completed':
      return row.status === 'completed';
    case 'cancelled':
      return row.status === 'cancelled';
    case 'stalled':
      return row.stalled;
    default:
      return true;
  }
}

/** Whole-set status counts from a complete row list (filter-independent). */
export function deriveOversightCounts(
  rows: ReadonlyArray<EngagementOversightRow>
): OversightCounts {
  return {
    active: rows.filter((r) => r.status === 'active').length,
    inReview: rows.filter((r) => r.status === 'pending_acceptance').length,
    stalled: rows.filter((r) => r.stalled).length,
    completed: rows.filter((r) => r.status === 'completed').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
  };
}
