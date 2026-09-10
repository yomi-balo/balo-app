import {
  creditReceivablesRepository,
  creditSessionsRepository,
  expertsRepository,
  meetingRecordingsRepository,
  transcriptsRepository,
  calendarRepository,
  calendarSubscriptionsRepository,
  type OpenReceivableAlertRow,
  type AdminAlertFinding,
} from '@balo/db';
import type { AdminAlertDetail } from '@balo/shared/admin-alerts';
import { resolveWebhookBaseUrl } from '../services/calendar/webhook-url.js';
import {
  SUBSCRIPTION_EXPIRY_ALERT_MS,
  SUBSCRIPTION_UNCONFIRMED_GRACE_MS,
} from './calendar-subscription-monitor.js';
import { formatAudMinor } from '../notifications/channels/templates/credit-format.js';
import { sanitizedErrorMessage } from '../lib/sanitize-error.js';

/**
 * BAL-548 / ADR-1055 — the seven `admin_alerts` FINDER implementations, keyed by the NAME the
 * registry (`@balo/shared/admin-alerts`) holds on each finder-kind's `finder` field.
 * `packages/shared` cannot hold these functions (it imports no db, by rule), so the registry
 * holds a NAME and this module holds the implementation.
 * `packages/db/src/invariants/admin-alert-kinds-have-exactly-one-writer.test.ts` asserts the
 * registry's finder names and this object's keys are EQUAL SETS, both directions.
 */

// ── The finder contract (§B.4.2) ───────────────────────────────────────────

export interface AdminAlertFinderContext {
  readonly now: Date;
  readonly limit: number;
}

export interface AdminAlertFinderOutcome {
  readonly findings: readonly AdminAlertFinding[];
  /** True when the underlying read filled its batch bound — the sweep warns. "No silent caps." */
  readonly batchFilled: boolean;
  /** Set when the kind is deliberately skipped this tick (e.g. the calendar feature gate). */
  readonly skipped?: 'feature_disabled';
}

export type AdminAlertFinder = (ctx: AdminAlertFinderContext) => Promise<AdminAlertFinderOutcome>;

// ── Shared presentation helpers ─────────────────────────────────────────

/** `en-GB`, UTC, short — e.g. `12 Jul 2027`. Presentation only; never touches money/settlement math. */
function formatDateShort(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function personName(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName].filter((part): part is string => part !== null).join(' ');
  return name.length > 0 ? name : 'An expert';
}

/** `'Recording failed'` / `'Recording failed at ingest'` — one title-builder for both the
 *  recording and transcript failure finders, avoiding a nested template literal (sonarjs). */
function failedTitle(subject: string, failedStage: string | null): string {
  const stageSuffix = failedStage === null ? '' : ` at ${failedStage}`;
  return `${subject} failed${stageSuffix}`;
}

// ── Per-kind cutoffs (§B.4.2) ────────────────────────────────────────────

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** An application submitted minutes ago is not "waiting". */
export const EXPERT_APPLICATION_PENDING_CUTOFF_MS = 2 * MS_PER_HOUR;
/** A receivable opened today is still being auto-settled. */
export const RECEIVABLE_OPEN_CUTOFF_MS = 24 * MS_PER_HOUR;
/** ⚠ MUST NOT DIVERGE from `credit-session-meter-sweep.ts`'s `SETTLED_MISSING_CREDIT_MINUTES`
 *  (60) — R4: this finder calls the SAME read IN ADDITION, and a different cutoff here would
 *  make the two alarms disagree about what "stuck" means for the identical condition. */
export const SESSION_SETTLED_NO_LEDGER_CREDIT_CUTOFF_MS = 60 * MS_PER_MINUTE;
/** Past the ingest retry ladder. */
export const RECORDING_FAILED_CUTOFF_MS = 15 * MS_PER_MINUTE;
/** Past the pipeline retry ladder. */
export const TRANSCRIPT_FAILED_CUTOFF_MS = 15 * MS_PER_MINUTE;
/** A batch job that answers in minutes is not withheld. */
export const TRANSCRIPT_CAPTURE_WITHHELD_SOURCE_CUTOFF_MS = 24 * MS_PER_HOUR;

// ── expert.application_pending ──────────────────────────────────────────

async function expertApplicationPending(
  ctx: AdminAlertFinderContext
): Promise<AdminAlertFinderOutcome> {
  const cutoff = new Date(ctx.now.getTime() - EXPERT_APPLICATION_PENDING_CUTOFF_MS);
  const rows = await expertsRepository.listPendingApplicationsForAlerts(cutoff, ctx.limit);
  const batchFilled = rows.length === ctx.limit;

  const findings: AdminAlertFinding[] = rows.map((row) => {
    const name = personName(row.userFirstName, row.userLastName);
    const statusLabel =
      row.applicationStatus === 'under_review' ? 'under review' : 'awaiting review';
    return {
      entityType: 'expert',
      entityId: row.expertProfileId,
      detail: {
        title: `${name} is waiting for an application decision`,
        entityLabel: row.agencyName === null ? name : `${name} @ ${row.agencyName}`,
        evidence: `Application submitted ${formatDateShort(row.submittedAt)} and still ${statusLabel}.`,
        facts: [
          ['Applicant', name],
          ['Agency', row.agencyName ?? 'Independent'],
          ['Status', statusLabel],
          ['Submitted', formatDateShort(row.submittedAt)],
        ],
      },
    };
  });

  return { findings, batchFilled };
}

// ── receivable.open ──────────────────────────────────────────────────────

async function receivableOpen(ctx: AdminAlertFinderContext): Promise<AdminAlertFinderOutcome> {
  const cutoff = new Date(ctx.now.getTime() - RECEIVABLE_OPEN_CUTOFF_MS);
  const rows = await creditReceivablesRepository.listOpen(cutoff, ctx.limit);
  const batchFilled = rows.length === ctx.limit;

  // ⚠ THE ALERT'S GRAIN IS THE COMPANY, NOT THE RECEIVABLE (R5). This read returns one row per
  // receivable; folding into one Finding per company is this finder's job.
  const byCompany = new Map<string, OpenReceivableAlertRow[]>();
  for (const row of rows) {
    const existing = byCompany.get(row.companyId);
    if (existing === undefined) {
      byCompany.set(row.companyId, [row]);
    } else {
      existing.push(row);
    }
  }

  const findings: AdminAlertFinding[] = [...byCompany.entries()].flatMap(
    ([companyId, receivables]) => {
      const [firstReceivable] = receivables;
      if (firstReceivable === undefined) {
        return [];
      }
      const companyName = firstReceivable.companyName;
      const totalMinor = receivables.reduce((sum, r) => sum + r.amountMinor, 0);
      const oldestOpenedAt = receivables.reduce(
        (oldest, r) => (r.openedAt < oldest ? r.openedAt : oldest),
        firstReceivable.openedAt
      );
      // ⚠⚠ A-F8 — the READ is bounded at `ctx.limit` RECEIVABLES, but the FINDING is
      // company-GRAINED (R5): a company whose open receivables straddle the batch cut can have
      // some counted here and the rest silently excluded from this tick's read entirely — so
      // "N open receivables" can UNDERCOUNT. Ordering is deterministic (oldest-first, then id),
      // so a company's rendered count never flaps between ticks — but when the batch filled,
      // treat every count and total in THIS tick as a LOWER BOUND, not an exact figure. The `+`
      // says so; it is deliberately blanket across every company this tick rather than
      // per-company, because cheaply proving any ONE company's set is complete would need a
      // second, unbounded query this finder is not meant to run.
      const countLabel = batchFilled ? `${receivables.length}+` : String(receivables.length);
      const showsPlural = batchFilled || receivables.length > 1;
      const amountLabel = batchFilled
        ? `${formatAudMinor(totalMinor)}+`
        : formatAudMinor(totalMinor);

      return [
        {
          entityType: 'company',
          entityId: companyId,
          detail: {
            title: showsPlural
              ? `${companyName} has ${countLabel} open receivables`
              : `${companyName} has an open receivable`,
            entityLabel: companyName,
            evidence: `${amountLabel} owed across ${countLabel} receivable${showsPlural ? 's' : ''}, oldest opened ${formatDateShort(oldestOpenedAt)}.`,
            facts: [
              ['Amount owed', amountLabel],
              ['Receivable count', countLabel],
              ['Oldest opened', formatDateShort(oldestOpenedAt)],
              ['Receivable ids', receivables.map((r) => r.receivableId).join(', ')],
            ],
          },
        },
      ];
    }
  );

  return { findings, batchFilled };
}

// ── session.settled_no_ledger_credit ────────────────────────────────────

/**
 * R4 — `findSettledMissingLedgerCredit` is ALREADY called by
 * `apps/api/src/jobs/credit-session-meter-sweep.ts:416`
 * (`apps/api/src/invariants/settled-implies-ledger-credit.test.ts:110` asserts that file's
 * source still contains the call). This finder calls it IN ADDITION — that file is left
 * completely untouched.
 */
async function sessionSettledNoLedgerCredit(
  ctx: AdminAlertFinderContext
): Promise<AdminAlertFinderOutcome> {
  const cutoff = new Date(ctx.now.getTime() - SESSION_SETTLED_NO_LEDGER_CREDIT_CUTOFF_MS);
  const sessions = await creditSessionsRepository.findSettledMissingLedgerCredit(cutoff, ctx.limit);
  const batchFilled = sessions.length === ctx.limit;

  const findings: AdminAlertFinding[] = sessions.map((session) => {
    const settledAt = session.settledAt ?? ctx.now;
    const overdraftLabel =
      session.overdraftSettledMinor === null
        ? 'n/a'
        : formatAudMinor(session.overdraftSettledMinor);
    const detail: AdminAlertDetail = {
      title: 'Settled session has no ledger credit',
      entityLabel: `Session settled ${formatDateShort(settledAt)}`,
      evidence:
        'Marked settled but no overdraft_settlement ledger row exists — money may have been ' +
        'charged with nothing recorded against the wallet.',
      facts: [
        ['Wallet', session.walletId],
        ['Company', session.companyId],
        ['Settled', formatDateShort(settledAt)],
        ['Overdraft settled', overdraftLabel],
        ['Stripe PaymentIntent', session.stripePaymentIntentId ?? 'none'],
      ],
      ...(session.meetingId === null ? {} : { targetId: session.meetingId }),
    };
    return { entityType: 'session', entityId: session.id, detail };
  });

  return { findings, batchFilled };
}

// ── recording.failed ─────────────────────────────────────────────────────

async function recordingFailed(ctx: AdminAlertFinderContext): Promise<AdminAlertFinderOutcome> {
  const cutoff = new Date(ctx.now.getTime() - RECORDING_FAILED_CUTOFF_MS);
  const rows = await meetingRecordingsRepository.listFailedSince(cutoff, ctx.limit);
  const batchFilled = rows.length === ctx.limit;

  const findings: AdminAlertFinding[] = rows.map((row) => {
    // ⚠ A-F5 — `failureReason` may echo a raw vendor error body (the `sanitize-error.ts`
    // doctrine: Mux's `invalid_parameters` bodies can echo the offending input, e.g. a live
    // Daily signed access link). Unlike the webhook handlers this doctrine already covers, a
    // permanently-failed row never self-closes, so an unsanitized string here sits in `detail`
    // — a staff-readable but still persisted column — forever.
    const sanitizedFailureReason =
      row.failureReason === null ? null : sanitizedErrorMessage(row.failureReason);
    return {
      entityType: 'recording',
      entityId: row.recordingId,
      detail: {
        title: failedTitle('Recording', row.failedStage),
        entityLabel: `Consultation ${formatDateShort(row.meetingScheduledStart)}`,
        evidence: `${sanitizedFailureReason ?? 'The recording pipeline failed'} — no playable recording exists.`,
        facts: [
          ['Consultation', formatDateShort(row.meetingScheduledStart)],
          ['Failed stage', row.failedStage ?? 'unknown'],
          ['Failure reason', sanitizedFailureReason ?? 'none recorded'],
          ['Daily recording id', row.dailyRecordingId ?? 'none'],
          ['Mux asset id', row.muxAssetId ?? 'none'],
        ],
        targetId: row.meetingId,
      },
    };
  });

  return { findings, batchFilled };
}

// ── transcript.failed ────────────────────────────────────────────────────

async function transcriptFailed(ctx: AdminAlertFinderContext): Promise<AdminAlertFinderOutcome> {
  const cutoff = new Date(ctx.now.getTime() - TRANSCRIPT_FAILED_CUTOFF_MS);
  const rows = await transcriptsRepository.listFailedSince(cutoff, ctx.limit);
  const batchFilled = rows.length === ctx.limit;

  const findings: AdminAlertFinding[] = rows.map((row) => {
    // ⚠ A-F5 — same doctrine as `recordingFailed` above: never persist a raw vendor error body.
    const sanitizedFailureReason =
      row.failureReason === null ? null : sanitizedErrorMessage(row.failureReason);
    return {
      entityType: 'transcript',
      entityId: row.transcriptId,
      detail: {
        title: failedTitle('Transcript', row.failedStage),
        entityLabel: `Consultation ${formatDateShort(row.meetingScheduledStart)}`,
        evidence: `${sanitizedFailureReason ?? 'The transcript pipeline failed'} — the recap will not reach ready.`,
        facts: [
          ['Consultation', formatDateShort(row.meetingScheduledStart)],
          ['Failed stage', row.failedStage ?? 'unknown'],
          ['Failure reason', sanitizedFailureReason ?? 'none recorded'],
        ],
        targetId: row.meetingId,
      },
    };
  });

  return { findings, batchFilled };
}

// ── transcript_capture.withheld_source ──────────────────────────────────

/**
 * R6 — despite the kind's NAME, this is a `meeting_recordings` predicate, not a transcripts
 * one. See `meetingRecordingsRepository.listWithheldTranscriptSourceSince`'s docblock.
 */
async function transcriptCaptureWithheldSource(
  ctx: AdminAlertFinderContext
): Promise<AdminAlertFinderOutcome> {
  const cutoff = new Date(ctx.now.getTime() - TRANSCRIPT_CAPTURE_WITHHELD_SOURCE_CUTOFF_MS);
  const rows = await meetingRecordingsRepository.listWithheldTranscriptSourceSince(
    cutoff,
    ctx.limit
  );
  const batchFilled = rows.length === ctx.limit;

  const findings: AdminAlertFinding[] = rows.map((row) => ({
    entityType: 'recording',
    entityId: row.recordingId,
    detail: {
      title: 'Batch transcription job never answered',
      entityLabel: `Consultation ${formatDateShort(row.meetingScheduledStart)}`,
      evidence:
        'The Daily Batch Processor job was submitted and has not answered — the vendor source ' +
        'is withheld from cleanup and the transcript is stalled.',
      facts: [
        ['Consultation', formatDateShort(row.meetingScheduledStart)],
        ['Transcript job id', row.transcriptJobId ?? 'none'],
        ['Job submitted', formatDateShort(row.transcriptJobSubmittedAt)],
        ['Daily recording id', row.dailyRecordingId ?? 'none'],
      ],
      targetId: row.meetingId,
    },
  }));

  return { findings, batchFilled };
}

// ── calendar.subscription_lapse ─────────────────────────────────────────

type CalendarLapseArm = 'expiring' | 'unconfirmed' | 'unsubscribed';

const ARM_DESCRIPTIONS: Record<CalendarLapseArm, string> = {
  expiring: 'the subscription is expiring soon',
  unconfirmed: 'a created subscription was never confirmed',
  unsubscribed: 'the connection is ACTIVE but has no live subscription at all',
};

const ARM_ORDER: readonly CalendarLapseArm[] = ['expiring', 'unconfirmed', 'unsubscribed'];

function describeArms(arms: ReadonlySet<CalendarLapseArm>): string {
  const ordered = ARM_ORDER.filter((arm) => arms.has(arm));
  return ordered.map((arm) => ARM_DESCRIPTIONS[arm]).join('; ') || 'no arm recorded';
}

/**
 * R5 — three v1 kinds sit on populations an existing cron already sweeps. This finder calls
 * the SAME repository reads INDEPENDENTLY of `calendar-subscription-monitor.ts`; it does not
 * move them, and it does NOT enqueue a reconcile (self-heal stays the monitor's job — a read
 * that writes would violate D3).
 *
 * ⚠⚠ ALL THREE ARMS ARE GATED, NOT JUST THE THIRD — `listActiveConnectionsWithoutSubscription`
 * carries a HARD caller contract ("THE CALLER MUST GATE THIS ARM ON THE FEATURE BEING
 * CONFIGURED"), and gating only that arm would still let the other two alert daily, forever,
 * on a condition self-heal cannot repair while the feature is off — exactly the reasoning
 * `calendar-subscription-monitor.ts`'s own docblock states for gating its whole sweep.
 */
async function calendarSubscriptionLapse(
  ctx: AdminAlertFinderContext
): Promise<AdminAlertFinderOutcome> {
  const featureConfigured = resolveWebhookBaseUrl() !== null;
  if (!featureConfigured) {
    return { findings: [], batchFilled: false, skipped: 'feature_disabled' };
  }

  const nowMs = ctx.now.getTime();
  const expiring = await calendarSubscriptionsRepository.listExpiringBefore(
    new Date(nowMs + SUBSCRIPTION_EXPIRY_ALERT_MS),
    ctx.limit
  );
  const unconfirmed = await calendarSubscriptionsRepository.listUnconfirmedBefore(
    new Date(nowMs - SUBSCRIPTION_UNCONFIRMED_GRACE_MS),
    ctx.limit
  );
  const unsubscribed =
    await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(ctx.limit);

  const batchFilled =
    expiring.length === ctx.limit ||
    unconfirmed.length === ctx.limit ||
    unsubscribed.length === ctx.limit;

  const armsByConnection = new Map<string, Set<CalendarLapseArm>>();
  const addArm = (connectionId: string, arm: CalendarLapseArm): void => {
    const existing = armsByConnection.get(connectionId);
    if (existing === undefined) {
      armsByConnection.set(connectionId, new Set([arm]));
    } else {
      existing.add(arm);
    }
  };
  for (const row of expiring) addArm(row.connectionId, 'expiring');
  for (const row of unconfirmed) addArm(row.connectionId, 'unconfirmed');
  for (const row of unsubscribed) addArm(row.connectionId, 'unsubscribed');

  const connectionIds = [...armsByConnection.keys()];
  const labels = await calendarRepository.listConnectionAlertLabels(connectionIds);

  const findings: AdminAlertFinding[] = connectionIds.flatMap((connectionId) => {
    const label = labels.get(connectionId);
    // ⚠ A connection missing from the hydration is the answer, not an error — it was
    // soft-deleted between the arm's read and this one (a disconnect racing the sweep).
    if (label === undefined) {
      return [];
    }
    const arms = armsByConnection.get(connectionId) ?? new Set<CalendarLapseArm>();
    const name = personName(label.userFirstName, label.userLastName);

    return [
      {
        entityType: 'calendar',
        entityId: connectionId,
        detail: {
          title: `${name}'s ${label.provider} calendar sync needs attention`,
          entityLabel: label.agencyName === null ? name : `${name} @ ${label.agencyName}`,
          evidence: `${describeArms(arms)}.`,
          facts: [
            ['Expert', name],
            ['Agency', label.agencyName ?? 'Independent'],
            ['Provider', label.provider],
            ['Arms', ARM_ORDER.filter((arm) => arms.has(arm)).join(', ')],
            ['Connected since', formatDateShort(label.connectionCreatedAt)],
          ],
        },
      },
    ];
  });

  return { findings, batchFilled };
}

// ── The registry ─────────────────────────────────────────────────────────

/**
 * ⚠ THE KEYS OF THIS RECORD ARE THE `finder` STRINGS IN `ADMIN_ALERT_KINDS`, AND NOTHING ELSE.
 * `packages/db/src/invariants/admin-alert-kinds-have-exactly-one-writer.test.ts` asserts the
 * two sets are EQUAL in both directions, so a renamed finder or an orphaned implementation
 * fails CI rather than throwing at 03:00 on a Sunday.
 */
export const ADMIN_ALERT_FINDERS: Readonly<Record<string, AdminAlertFinder>> = {
  expertApplicationPending,
  receivableOpen,
  sessionSettledNoLedgerCredit,
  recordingFailed,
  transcriptFailed,
  transcriptCaptureWithheldSource,
  calendarSubscriptionLapse,
};
