import { isPlatformAdminRole, personDisplayName, personWithOrgLabel } from '../parties';
import type { ExpertSearchabilitySource } from '../experts/checklist';
import type { LookupEntityType } from './types';

/**
 * BAL-555 — the Lookup Timeline's plain-words layer.
 *
 * Pure, client-safe, no `@balo/db`, no I/O — this subpath's stated rule (`./types`'s header
 * comment). Lives in `@balo/shared` (not `@balo/db`) so both the web loader and its own unit
 * tests can import it without dragging `postgres` into any bundle (memory
 * `reference_balo_db_client_bundle_footgun`), and so the sentence table is unit-tested with
 * NO Docker (SonarCloud new-code coverage).
 */

/**
 * ⚠ THE SECURITY ALLOW-LIST, not merely a label map. The Timeline's Server Action takes a
 * `LookupEntityType` — never a free `entity_type` string — and resolves it here, so a client
 * cannot ask for the trail of an entity type Lookup does not select (`internal_note`, whose
 * metadata names its subject, is the sharpest example). `Record<LookupEntityType, string>` is
 * exhaustive, so adding a member to `LOOKUP_ENTITY_TYPES` fails tsc until it is mapped here.
 *
 * ⚠ `expert` → `expert_profile`. The Lookup badge and the audit key differ for exactly one
 * member (`_shared/schedule-audit.ts`, `expert-searchability.ts`); forwarding the badge would
 * return zero rows for every expert, silently.
 */
export const LOOKUP_AUDIT_ENTITY_TYPE: Record<LookupEntityType, string> = {
  user: 'user',
  expert: 'expert_profile',
  company: 'company',
  agency: 'agency',
  project_request: 'project_request',
  engagement: 'engagement',
  credit_session: 'credit_session',
};

export interface AuditActorFacts {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly platformRole: 'user' | 'admin' | 'super_admin' | null;
  readonly companyName: string | null;
  readonly agencyName: string | null;
}

/**
 * RETROSPECTIVE attribution — CLAUDE.md names the PERSON with "@ company/agency" (the tense
 * rule). `"MJ @ Balo"` for staff, `"Dana Whitfield @ Northwind Industrial"` for a client
 * member, `"Priya Nair @ CloudPeak"` for an agency expert, a bare name for an independent
 * expert.
 *
 * ⚠ `null` FOR A NULL ACTOR — never `"System"`, never a fabricated name. ADR-1030's
 * SYSTEM-ACTOR ATTRIBUTION EXEMPTION is "an unattributed row, never a fabricated actor"
 * (`_shared/delivery-audit.ts`), so the sentence simply carries no by-clause.
 *
 * Built on `@balo/shared/parties` — `isPlatformAdminRole`, `personDisplayName`,
 * `personWithOrgLabel`. Do NOT hand-roll the `@ org` join or a second ADMIN_ROLES set.
 *
 * Priority when an actor's facts carry more than one label: platform staff first (they act AS
 * Balo regardless of any marketplace membership they might also hold), then a live company
 * membership, then a live agency membership, then a bare name (an independent expert, or an
 * actor with no live membership at all).
 */
export function auditActorLabel(actor: AuditActorFacts | null): string | null {
  if (actor === null) return null;

  const person = personDisplayName(actor.firstName, actor.lastName, 'Unknown');

  if (actor.platformRole !== null && isPlatformAdminRole(actor.platformRole)) {
    return personWithOrgLabel(person, 'Balo');
  }
  if (actor.companyName !== null) {
    return personWithOrgLabel(person, actor.companyName);
  }
  if (actor.agencyName !== null) {
    return personWithOrgLabel(person, actor.agencyName);
  }
  return person;
}

// ── metadata field readers — defensive over genuinely `unknown` jsonb ────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(m: Record<string, unknown>, key: string, fallback = 'unknown'): string {
  const value = m[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(m: Record<string, unknown>, key: string, fallback = 0): number {
  const value = m[key];
  return typeof value === 'number' ? value : fallback;
}

/** `reason` trimmed to 140 chars — staff free text, staff-only surface. */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function capitalizeFirst(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * BAL-555 fix round F2 — plain-words labels for {@link ExpertSearchabilitySource}, the metadata
 * `source` value on `expert_profile.searchability_granted`/`_revoked`. Without this map the raw
 * enum slug (`calendar_credential_break`, `dashboard_read`, …) interpolated verbatim into a
 * sentence read as "Removed from search (calendar_credential_break)" — a support person reading
 * a bare slug amid otherwise plain English. `Record<ExpertSearchabilitySource, string>` is
 * exhaustive, so adding a member to the union fails `tsc` until it is labelled here too — the
 * same allow-list-by-construction shape `LOOKUP_AUDIT_ENTITY_TYPE` already uses.
 */
export const EXPERT_SEARCHABILITY_SOURCE_LABEL: Record<ExpertSearchabilitySource, string> = {
  calendar_credential_break: 'a broken calendar connection',
  calendar_credential_repair: 'a repaired calendar connection',
  calendar_connected: 'a calendar being connected',
  calendar_disconnected: 'a calendar being disconnected',
  calendar_sync_pending: 'a calendar sync still pending',
  dashboard_read: 'a dashboard visit',
};

/** Falls back to the raw value for anything outside the union — defensive over genuinely
 * `unknown` jsonb (`readString`'s contract), never a thrown error over a metadata surprise. */
function expertSearchabilitySourceLabel(source: string): string {
  return Object.hasOwn(EXPERT_SEARCHABILITY_SOURCE_LABEL, source)
    ? EXPERT_SEARCHABILITY_SOURCE_LABEL[source as ExpertSearchabilitySource]
    : source;
}

/**
 * The fallback for any `action` not in {@link AUDIT_ACTION_SENTENCES} — `audit_events.action`
 * is deliberately open TEXT that "grows without a migration per event"
 * (`schema/audit-events.ts`), so a missing entry MUST degrade gracefully, never render
 * `undefined`.
 *
 * `party_domain.captured` ⇒ `Domain captured`: the LAST underscore-segment of the namespace
 * (before the first `.`) stands in for the entity name, joined with the tail's words. Not
 * `humanizeEnumLabel` from `platform-lookup.ts` — a different transform, and hoisting a
 * one-liner across packages is churn for no reuse.
 */
export function humanizeActionTail(action: string): string {
  const dotIndex = action.indexOf('.');
  if (dotIndex === -1) {
    return capitalizeFirst(action.split('_').join(' '));
  }
  const namespaceParts = action.slice(0, dotIndex).split('_');
  const lastNamespaceWord = namespaceParts[namespaceParts.length - 1] ?? '';
  const tailWords = action.slice(dotIndex + 1).split('_');
  return capitalizeFirst([lastNamespaceWord, ...tailWords].join(' '));
}

/**
 * The plain-words sentence table — a DATA STRUCTURE `describeAuditEvent` iterates, not a chain
 * of `if`s. Every action here was verified against its write site on this worktree (BAL-555
 * plan §3.2).
 *
 * ⚠⚠ NO CURRENCY AMOUNT AND NO FEE PERCENTAGE, IN ANY SENTENCE, EVER. `LookupResult`'s own
 * contract keeps expert earnings and Balo margin behind the Money section's capability-gated
 * hop, and this surface sits in the SAME drill-in. `credit_session.expert_accrued` carries
 * `metadata.expertAccruedMinor` and `project_request.balo_fee_overridden` carries
 * `previous_bps`/`new_bps`; both are rendered WITHOUT the figure. `timeline.test.ts` pins this
 * as a property over the whole table.
 */
export const AUDIT_ACTION_SENTENCES: Record<string, (m: Record<string, unknown>) => string> = {
  'user.workos_relinked': () => 'Sign-in identity re-linked',

  'impersonation.started': (m) =>
    `Impersonation started — "${truncate(readString(m, 'reason', ''), 140)}"`,
  'impersonation.stopped': (m) =>
    m.outcome === 'restore_unavailable'
      ? 'Impersonation ended — the staff session could not be restored'
      : 'Impersonation ended',

  'expert_schedule.updated': () => 'Weekly schedule updated',
  'expert_schedule.cleared': () => 'Weekly schedule cleared',
  'expert_timezone.changed': (m) =>
    `Timezone changed from ${readString(m, 'oldTimezone')} to ${readString(m, 'newTimezone')}`,
  'expert_profile.searchability_granted': (m) =>
    `Searchable again (${expertSearchabilitySourceLabel(readString(m, 'source'))})`,
  'expert_profile.searchability_revoked': (m) =>
    `Removed from search (${expertSearchabilitySourceLabel(readString(m, 'source'))})`,

  'company.join_mode_changed': (m) =>
    `Domain join mode changed from ${readString(m, 'from')} to ${readString(m, 'to')}`,
  'company.billing_email_seeded': (m) => `Billing email set to ${readString(m, 'email')}`,
  'company.billing_email_changed': (m) =>
    `Billing email changed from ${readString(m, 'previous_email')} to ${readString(m, 'new_email')}`,
  'company.promoted_to_organization': (m) =>
    `Promoted to an organization on ${readString(m, 'domain')}`,

  'agency.created': () => 'Agency created',
  'agency.ownership_transferred': () => 'Ownership transferred',

  'project_request.balo_fee_overridden': () => 'Balo fee overridden',
  'project_request.owner_assigned': (m) =>
    m.to === null ? 'Balo owner cleared' : 'Balo owner assigned',
  'project_request.closed': (m) => {
    const reason = readString(m, 'reason');
    const counts = asRecord(m.counts);
    const terms: string[] = [];
    const tracksDeclined = readNumber(counts, 'tracksDeclined');
    const proposalsWithdrawn = readNumber(counts, 'proposalsWithdrawn');
    const meetingsCancelled = readNumber(counts, 'meetingsCancelled');
    if (tracksDeclined > 0) terms.push(`${tracksDeclined} tracks declined`);
    if (proposalsWithdrawn > 0) terms.push(`${proposalsWithdrawn} proposals withdrawn`);
    if (meetingsCancelled > 0) terms.push(`${meetingsCancelled} meetings cancelled`);
    const suffix = terms.length > 0 ? `, ${terms.join(' · ')}` : '';
    return `Request closed (${reason})${suffix}`;
  },

  'credit_session.expert_accrued': (m) =>
    `Expert accrual recorded for ${readNumber(m, 'connectedMinutes')} connected minutes`,
  'credit_session.presence_settled': (m) => {
    const billableMinutes = readNumber(m, 'billableMinutes');
    const base = `Settled — ${billableMinutes} min billed`;
    if (m.floorApplied !== true) return base;
    const actualMinutes = readNumber(m, 'actualMinutes');
    const floorMinutes = readNumber(m, 'floorMinutes');
    return `${base}, ${actualMinutes} min actual at the ${floorMinutes}-minute minimum`;
  },

  'engagement.created': (m) =>
    readString(m, 'engagement_type') === 'case' ? 'Case created' : 'Project created',
  'engagement.milestones_snapshotted': () => 'Milestones snapshotted from the accepted proposal',
  'engagement.completion_requested': () => 'Completion requested',
  'engagement.completion_withdrawn': () => 'Completion request withdrawn',
  'engagement.accepted': () => 'Delivery accepted',
  'engagement.changes_requested': () => 'Changes requested',
  'engagement.cancelled': () => 'Engagement cancelled',
  'engagement.case_closed': () => 'Case closed',

  'engagement_milestone.reordered': () => 'Milestones reordered',
};

/**
 * The plain-words sentence for one audit row: `AUDIT_ACTION_SENTENCES[action]` applied to the
 * row's metadata, plus the by-clause. Falls back to {@link humanizeActionTail} for any
 * unmapped action.
 *
 * ⚠ GENDER-NEUTRAL BY CONSTRUCTION — no sentence contains a pronoun. Pinned by a property
 * test.
 */
export function describeAuditEvent(input: {
  readonly action: string;
  readonly metadata: unknown;
  readonly actorLabel: string | null;
}): string {
  // ⚠ BAL-555 fix round F5 — `Object.hasOwn`, never a bare index lookup. `audit_events.action`
  // is arbitrary TEXT off the wire (via `metadata`-adjacent narrowing, never validated against
  // an enum before it reaches here), so `AUDIT_ACTION_SENTENCES[input.action]` reaches
  // `Object.prototype` for an action like `'toString'` (`"[object Undefined]"`, silently wrong)
  // or `'constructor'` (returns an OBJECT from a `: string`-typed function — React throws on
  // render). `Object.hasOwn` closes both without a `Map` migration.
  const compose = Object.hasOwn(AUDIT_ACTION_SENTENCES, input.action)
    ? AUDIT_ACTION_SENTENCES[input.action]
    : undefined;
  const sentence =
    compose === undefined ? humanizeActionTail(input.action) : compose(asRecord(input.metadata));
  return input.actorLabel === null ? sentence : `${sentence} — ${input.actorLabel}`;
}

/**
 * ONE Timeline row as it crosses to the browser. ⚠ NO `metadata`, NO `actorUserId`, NO `seq`
 * beyond the cursor — the loader is the projection point and this shape is the allow-list. Raw
 * `metadata` jsonb carries WorkOS ids, billing emails and staff free text; only what a
 * sentence names crosses.
 */
export interface LookupTimelineEntry {
  /** `audit_events.id` — the React key. */
  readonly id: string;
  /** The raw dot-namespaced action, rendered in a monospace face. */
  readonly action: string;
  /** The plain-words sentence, actor attribution included. */
  readonly summary: string;
  /** ISO instant. ⚠ NO `Date` CROSSES THE BOUNDARY (the `oversight-row.ts` house rule). */
  readonly occurredAtIso: string;
}

export interface LookupTimelineCursorDTO {
  /**
   * ⚠ NOT STRICT ISO 8601 — named `createdAtPrecise` (BAL-555 fix round F6), matching
   * `AuditTrailCursor.createdAtPrecise` (`packages/db/src/repositories/audit-events.ts`) that
   * this DTO carries verbatim. This DTO is NEW in this PR — nothing has shipped against
   * `createdAtIso`, so there is no churn to protect; a name that lies about its own shape is
   * exactly the trap the microsecond-precision fix (BAL-426 residual 2) just closed, and
   * shipping it under a truthful name from day one costs nothing. Carries
   * `audit_events.created_at` at its FULL microsecond precision, exactly as Postgres prints it
   * (`created_at::text`, e.g. `'2026-09-11 10:00:00.083951+00'` — a space separator, no `T`, and
   * a 2-digit zone offset). A JS `Date` — and therefore `z.iso.datetime()` on the way in, or
   * `.toISOString()` on the way out — is millisecond-precision only; round-tripping through
   * either silently drops an entire same-millisecond cluster of rows at a page boundary. Treat
   * it as an OPAQUE, Postgres-parseable string on both sides of this boundary — never parse it
   * into a `Date`.
   */
  readonly createdAtPrecise: string;
  /** ⚠ A NUMBER. `seq` is `mode: 'number'` — never `String()` it and never compare lexically. */
  readonly seq: number;
}

/** The failure union mirrors `AdminSessionMoneyResult` so the Timeline panel's state machine
 * is the Money section's, verbatim. */
export type LookupTimelineResult =
  | {
      readonly ok: true;
      readonly entries: readonly LookupTimelineEntry[];
      readonly hasEarlier: boolean;
      readonly earlier: LookupTimelineCursorDTO | null;
    }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'unavailable' };
