import type { AdminAlertDetail } from './detail';
import type { AdminAlertGroup, AdminAlertCadence } from './groups';

/**
 * BAL-548 / ADR-1055 — the kind registry: THE thirteen-row table (twelve registered kinds,
 * one of which — `sweep.failed` — has no finder) that a `packages/db` invariant
 * (`admin-alert-kinds-have-exactly-one-writer.test.ts`) value-imports to prove every kind has
 * EXACTLY one writer: a finder XOR a `raise()` call site.
 *
 * ⚠ SEVEN FINDER KINDS, FOUR EVENT-DRIVEN, PLUS `sweep.failed` (rulings addendum §A2). The
 * ticket/rulings prose header said "eight finder kinds" at one point; the table — and this
 * file — are the seven-kind reading. `calendar.subscription_lapse` is ONE kind consuming
 * THREE finder reads, which is what inflated the miscount.
 */
export const ADMIN_ALERT_KIND_KEYS = [
  'expert.application_pending',
  'receivable.open',
  'session.settled_no_ledger_credit',
  'topup.unresolved_pi',
  'topup.partial_refund',
  'session.open_refused',
  'recording.failed',
  'transcript.failed',
  'transcript_capture.withheld_source',
  'calendar.subscription_lapse',
  'calendar.amend_failed',
  'sweep.failed',
] as const;

export type AdminAlertKind = (typeof ADMIN_ALERT_KIND_KEYS)[number];

export interface AdminAlertTargetInput {
  readonly entityId: string;
  readonly detail: AdminAlertDetail;
}
export interface AdminAlertTarget {
  /** Reads after "Open " on the button — "the application", "the company". Lower-case. */
  readonly label: string;
  /** An in-app path. ALWAYS starts with `/`; never an external URL. */
  readonly href: string;
}

export interface AdminAlertKindMeta {
  readonly group: AdminAlertGroup;
  /**
   * The NAME of the finder implementation, resolved in `apps/api` (`admin-alert-finders.ts`),
   * or `null` for an event-driven kind. `packages/shared` imports no db, so it can hold the
   * name and never the function.
   */
  readonly finder: string | null;
  /** ⚠ `null` IFF `finder` is null — pinned by `index.test.ts`. A cadence on a kind no sweep looks for is a lie. */
  readonly cadence: AdminAlertCadence | null;
  /** The row's "how it closes" sentence. */
  readonly closes: string;
  readonly target: (input: AdminAlertTargetInput) => AdminAlertTarget;
}

// ── Shared target builders ───────────────────────────────────────────────

/**
 * BAL-549 — the expert-application review page. Keyed on `expert_profiles.id`, which IS this
 * kind's `entity_id` (`apps/api/src/jobs/admin-alert-finders.ts:105`), so the deep link lands on
 * exactly the application the row is about.
 *
 * ⚠ SUPERSEDES the prior `/admin/catalogue` FALLBACK, and the reasoning that forced it. That
 * fallback existed because the only live expert route, `/experts/[username]`, is keyed on
 * `username` — which the finder does not project and a fresh applicant may not have set at all.
 * `/admin/applications/[profileId]` is id-keyed, so the coarse landing is no longer needed.
 */
function targetExpertApplication(input: AdminAlertTargetInput): AdminAlertTarget {
  return { label: 'the application', href: `/admin/applications/${input.entityId}` };
}

/**
 * ⚠ `receivable.open` (addendum §A5): the shipped engagements list
 * (`apps/web/src/app/(dashboard)/engagements/page.tsx`) accepts NO `searchParams` at all —
 * verified, not assumed. Shipping a `?company=` filter the page ignores would be a link that
 * silently does nothing, which the addendum calls worse than a coarser one. Falls back to the
 * admin catalogue.
 */
function targetCompanyCatalogue(): AdminAlertTarget {
  return { label: 'the company', href: '/admin/catalogue' };
}

function targetMeeting(input: AdminAlertTargetInput): AdminAlertTarget {
  return { label: 'the meeting', href: `/meetings/${input.entityId}` };
}

/**
 * `session.settled_no_ledger_credit` — the finding's `entity_id` is `credit_sessions.id`, not a
 * meeting id. The producer carries a best-effort routable meeting id in `detail.targetId` (never
 * parsed out of `facts`); absent that, it falls back to `entity_id` (a dead link is accepted for
 * this kind — see the finder's own docblock).
 */
function targetMeetingViaTargetId(input: AdminAlertTargetInput): AdminAlertTarget {
  return { label: 'the meeting', href: `/meetings/${input.detail.targetId ?? input.entityId}` };
}

/**
 * BAL-550 / D3 — the three capture kinds land on the detail lens, keyed on the MEETING id
 * (`detail.targetId`), the only identifier all three share: `transcript.failed` carries
 * `entityId = transcripts.id`, so the ticket's `?row=<meeting_recording_id>` is unimplementable.
 * ⚠ NO `?? input.entityId` FALLBACK, unlike `targetMeetingViaTargetId` — that fallback is already
 * wrong for `transcript.failed`, and here it would deep-link to a row that cannot exist. With no
 * `targetId` the unfiltered lens opens instead.
 */
function targetCaptureHealthViaTargetId(input: AdminAlertTargetInput): AdminAlertTarget {
  const targetId = input.detail.targetId;
  return {
    label: 'capture health',
    href:
      targetId === undefined ? '/admin/health/capture' : `/admin/health/capture?row=${targetId}`,
  };
}

/**
 * `calendar.subscription_lapse` — `/expert/settings?tab=schedule` loads calendar data from
 * the VIEWER's own session profile, not the expert the alert names. For a staff viewer that
 * is a dead link dressed as a live one (their own unrelated settings, or an empty page).
 * Same rule as `targetCompanyCatalogue`: coarse-but-live beats a dead link. Falls back to the
 * admin catalogue.
 *
 * ⚠ NO admin-side expert/calendar surface is shipped yet — unlike `targetExpertApplication`
 * above, which BAL-549 gave a real id-keyed target, this one still has none to point to.
 */
function targetCalendarSettings(): AdminAlertTarget {
  return { label: 'the calendar connection', href: '/admin/catalogue' };
}

/**
 * `topup.unresolved_pi` / `topup.partial_refund` — no plan target was ever specified (the
 * B.2.3 target table omits both). The finding is `wallet`-grained and no wallet- or
 * company-scoped admin surface is shipped, so this falls back to the admin catalogue, same as
 * `receivable.open` — the closest live surface, coarse but not dead.
 */
function targetWalletCatalogue(): AdminAlertTarget {
  return { label: 'the company', href: '/admin/catalogue' };
}

function targetQueue(): AdminAlertTarget {
  return { label: 'the queue', href: '/admin' };
}

// ── The registry ─────────────────────────────────────────────────────────

export const ADMIN_ALERT_KINDS: Readonly<Record<AdminAlertKind, AdminAlertKindMeta>> = {
  'expert.application_pending': {
    group: 'marketplace',
    finder: 'expertApplicationPending',
    cadence: '1m',
    closes: 'Closes itself once the application is approved or rejected',
    target: targetExpertApplication,
  },
  'receivable.open': {
    group: 'money',
    finder: 'receivableOpen',
    cadence: '1m',
    closes: 'Closes itself when the receivable clears',
    target: targetCompanyCatalogue,
  },
  'session.settled_no_ledger_credit': {
    group: 'money',
    finder: 'sessionSettledNoLedgerCredit',
    cadence: '1m',
    closes: 'Closes itself when the ledger credit lands',
    // ⚠ NOT `targetMeeting` — this kind's grain (B.4.2) is `session` / `credit_sessions.id`,
    // not a meeting id, and `credit_sessions` has no dedicated staff-reachable detail page.
    // The finder carries the session's `meetingId` as `detail.targetId` (best-effort; a
    // credit session with no meeting id is structurally unreachable in practice).
    target: targetMeetingViaTargetId,
  },
  'topup.unresolved_pi': {
    group: 'money',
    finder: null,
    cadence: null,
    closes:
      'No row to re-check — closes with a note once the PaymentIntent is found or the credit is adjusted',
    target: targetWalletCatalogue,
  },
  'topup.partial_refund': {
    group: 'money',
    finder: null,
    cadence: null,
    closes:
      'No row to re-check — closes with a note once the refund is completed or the remainder is credited',
    target: targetWalletCatalogue,
  },
  'session.open_refused': {
    group: 'money',
    finder: null,
    cadence: null,
    closes: 'No row to re-check — closes with a note once recovered or written off',
    target: targetMeeting,
  },
  'recording.failed': {
    group: 'capture',
    finder: 'recordingFailed',
    cadence: '5m',
    closes: 'Closes itself when a playable recording exists',
    target: targetCaptureHealthViaTargetId,
  },
  'transcript.failed': {
    group: 'capture',
    finder: 'transcriptFailed',
    cadence: '5m',
    closes: 'Closes itself when the recap reaches ready',
    target: targetCaptureHealthViaTargetId,
  },
  'transcript_capture.withheld_source': {
    group: 'capture',
    finder: 'transcriptCaptureWithheldSource',
    cadence: '5m',
    closes: 'Closes itself when the batch job answers or the source is released',
    target: targetCaptureHealthViaTargetId,
  },
  'calendar.subscription_lapse': {
    group: 'meetings',
    finder: 'calendarSubscriptionLapse',
    cadence: '15m',
    closes: 'Closes itself when the subscriptions exist',
    target: targetCalendarSettings,
  },
  'calendar.amend_failed': {
    group: 'meetings',
    finder: null,
    cadence: null,
    closes: 'No row to re-check — closes with a note after the amend is re-driven',
    target: targetMeeting,
  },
  'sweep.failed': {
    group: 'platform',
    finder: null,
    cadence: null,
    closes: 'No row to re-check — closes with a note once the sweep is healthy again',
    target: targetQueue,
  },
};

/** Membership only — never a bare object index (`__proto__` / `constructor` resolve on one). */
export function isKnownAdminAlertKind(kind: string): boolean {
  return Object.hasOwn(ADMIN_ALERT_KINDS, kind);
}

/** The kinds the close Server Action will accept. `finder === null` AND not a storm kind (no
 *  registry entry is ever a storm kind, so membership here already excludes them). */
export const NOTE_CLOSEABLE_KINDS: readonly AdminAlertKind[] = ADMIN_ALERT_KIND_KEYS.filter(
  (kind) => ADMIN_ALERT_KINDS[kind].finder === null
);

export function isNoteCloseableKind(kind: string): boolean {
  return (NOTE_CLOSEABLE_KINDS as readonly string[]).includes(kind);
}

/** The finder kinds for one cadence — what the sweep iterates. */
export function adminAlertKindsForCadence(cadence: AdminAlertCadence): readonly AdminAlertKind[] {
  return ADMIN_ALERT_KIND_KEYS.filter((kind) => ADMIN_ALERT_KINDS[kind].cadence === cadence);
}

/** A persisted `kind` string resolved to its registry metadata — a registered kind, or a
 *  derived `<base>.storm` kind (see `./storm`), which inherits its base's `group` and
 *  `target` and is ALWAYS sweep-closed (never note-closeable). */
export interface ResolvedAdminAlertKind {
  /** The kind exactly as persisted — may be a `.storm` kind. */
  readonly kind: string;
  /** The registered base kind (storm-stripped). */
  readonly baseKind: AdminAlertKind;
  readonly isStorm: boolean;
  readonly meta: AdminAlertKindMeta;
}
