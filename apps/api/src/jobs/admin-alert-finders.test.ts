import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * BAL-548 / ADR-1055 — unit coverage per finder: the cutoff arithmetic, `batchFilled` when the
 * read fills its bound, the produced Finding's grain, and — for `calendarSubscriptionLapse` —
 * the feature gate and the three-arm dedup.
 */

const {
  mockListPendingApplicationsForAlerts,
  mockListOpen,
  mockFindSettledMissingLedgerCredit,
  mockListFailedSinceRecordings,
  mockListWithheldTranscriptSourceSince,
  mockListFailedSinceTranscripts,
  mockListExpiringBefore,
  mockListUnconfirmedBefore,
  mockListActiveConnectionsWithoutSubscription,
  mockListConnectionAlertLabels,
  mockListUnprovisionedScheduled,
  mockListStrandedLive,
  mockListPresenceOverrunning,
  mockFindPresenceUnsettled,
  mockListPresenceAlertLabels,
} = vi.hoisted(() => ({
  mockListPendingApplicationsForAlerts: vi.fn(),
  mockListOpen: vi.fn(),
  mockFindSettledMissingLedgerCredit: vi.fn(),
  mockListFailedSinceRecordings: vi.fn(),
  mockListWithheldTranscriptSourceSince: vi.fn(),
  mockListFailedSinceTranscripts: vi.fn(),
  mockListExpiringBefore: vi.fn(),
  mockListUnconfirmedBefore: vi.fn(),
  mockListActiveConnectionsWithoutSubscription: vi.fn(),
  mockListConnectionAlertLabels: vi.fn(),
  mockListUnprovisionedScheduled: vi.fn(),
  mockListStrandedLive: vi.fn(),
  mockListPresenceOverrunning: vi.fn(),
  mockFindPresenceUnsettled: vi.fn(),
  mockListPresenceAlertLabels: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { listPendingApplicationsForAlerts: mockListPendingApplicationsForAlerts },
  creditReceivablesRepository: { listOpen: mockListOpen },
  creditSessionsRepository: {
    findSettledMissingLedgerCredit: mockFindSettledMissingLedgerCredit,
    listPresenceOverrunning: mockListPresenceOverrunning,
    findPresenceUnsettled: mockFindPresenceUnsettled,
    listPresenceAlertLabels: mockListPresenceAlertLabels,
  },
  meetingRecordingsRepository: {
    listFailedSince: mockListFailedSinceRecordings,
    listWithheldTranscriptSourceSince: mockListWithheldTranscriptSourceSince,
  },
  meetingsRepository: {
    listUnprovisionedScheduled: mockListUnprovisionedScheduled,
    listStrandedLive: mockListStrandedLive,
  },
  transcriptsRepository: { listFailedSince: mockListFailedSinceTranscripts },
  calendarRepository: { listConnectionAlertLabels: mockListConnectionAlertLabels },
  calendarSubscriptionsRepository: {
    listExpiringBefore: mockListExpiringBefore,
    listUnconfirmedBefore: mockListUnconfirmedBefore,
    listActiveConnectionsWithoutSubscription: mockListActiveConnectionsWithoutSubscription,
  },
}));

// Mocked so importing this module does not pull in `./calendar-subscription-monitor.js`'s own
// transitive chain (bullmq, redis, queue, the notification publisher) — this suite is about
// the FINDER's own logic, and `calendar-subscription-monitor.test.ts` already covers that
// module. Only the two coupled threshold constants are needed here.
vi.mock('./calendar-subscription-monitor.js', () => ({
  SUBSCRIPTION_EXPIRY_ALERT_MS: 48 * 60 * 60 * 1000,
  SUBSCRIPTION_UNCONFIRMED_GRACE_MS: 2 * 60 * 60 * 1000,
}));

// BAL-581 — a fixed timer set, so this suite's cutoff maths does not depend on env/default
// drift; `resolveMeetingTimers` itself is covered by `meeting-timers.test.ts`.
vi.mock('../config/meeting-timers.js', () => ({
  resolveMeetingTimers: () => ({
    expertAbsentAlertMs: 5 * 60_000,
    missedCallTerminationMs: 10 * 60_000,
    clientAbsentNudgeMs: 5 * 60_000,
    noShowFloorMs: 15 * 60_000,
    idleEndEmptyMs: 5 * 60_000,
    overrunStopGraceMs: 30 * 60_000,
  }),
}));

import {
  ADMIN_ALERT_FINDERS,
  EXPERT_APPLICATION_PENDING_CUTOFF_MS,
  RECEIVABLE_OPEN_CUTOFF_MS,
  SESSION_SETTLED_NO_LEDGER_CREDIT_CUTOFF_MS,
  RECORDING_FAILED_CUTOFF_MS,
  TRANSCRIPT_FAILED_CUTOFF_MS,
  TRANSCRIPT_CAPTURE_WITHHELD_SOURCE_CUTOFF_MS,
  MEETING_UNPROVISIONED_GRACE_MS,
  MEETING_STRANDED_AFTER_END_MS,
  MEETING_STRANDED_PAST_STOP_MS,
  PRESENCE_OVERRUN_MARGIN_MINUTES,
  PRESENCE_SETTLEMENT_EXHAUSTED_RUNBOOK,
} from './admin-alert-finders.js';
import { PRESENCE_UNSETTLED_ALERT_MS } from './presence-settlement-timing.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const LIMIT = 200;

beforeEach(() => {
  vi.clearAllMocks();
  mockListPendingApplicationsForAlerts.mockResolvedValue([]);
  mockListOpen.mockResolvedValue([]);
  mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
  mockListFailedSinceRecordings.mockResolvedValue([]);
  mockListWithheldTranscriptSourceSince.mockResolvedValue([]);
  mockListFailedSinceTranscripts.mockResolvedValue([]);
  mockListExpiringBefore.mockResolvedValue([]);
  mockListUnconfirmedBefore.mockResolvedValue([]);
  mockListActiveConnectionsWithoutSubscription.mockResolvedValue([]);
  mockListConnectionAlertLabels.mockResolvedValue(new Map());
  mockListUnprovisionedScheduled.mockResolvedValue([]);
  mockListStrandedLive.mockResolvedValue([]);
  mockListPresenceOverrunning.mockResolvedValue([]);
  mockFindPresenceUnsettled.mockResolvedValue([]);
  mockListPresenceAlertLabels.mockResolvedValue(new Map());
  delete process.env.APIROC_WEBHOOK_BASE_URL;
});

describe('expertApplicationPending', () => {
  it('passes the documented cutoff and reports batchFilled when the read fills its limit', async () => {
    mockListPendingApplicationsForAlerts.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({
        expertProfileId: `expert_${i}`,
        userFirstName: 'Priya',
        userLastName: 'Nair',
        agencyName: 'CloudPeak',
        submittedAt: NOW,
        applicationStatus: 'submitted',
      }))
    );

    const outcome = await ADMIN_ALERT_FINDERS.expertApplicationPending({ now: NOW, limit: LIMIT });

    expect(mockListPendingApplicationsForAlerts).toHaveBeenCalledWith(
      new Date(NOW.getTime() - EXPERT_APPLICATION_PENDING_CUTOFF_MS),
      LIMIT
    );
    expect(outcome.batchFilled).toBe(true);
    expect(outcome.findings).toHaveLength(LIMIT);
  });

  it('produces an expert-grained finding with a non-empty title/evidence', async () => {
    mockListPendingApplicationsForAlerts.mockResolvedValue([
      {
        expertProfileId: 'expert_1',
        userFirstName: 'Priya',
        userLastName: 'Nair',
        agencyName: 'CloudPeak',
        submittedAt: NOW,
        applicationStatus: 'under_review',
      },
    ]);

    const outcome = await ADMIN_ALERT_FINDERS.expertApplicationPending({ now: NOW, limit: LIMIT });

    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('expert');
    expect(finding?.entityId).toBe('expert_1');
    expect(finding?.detail.title.length).toBeGreaterThan(0);
    expect(finding?.detail.evidence.length).toBeGreaterThan(0);
    expect(finding?.detail.entityLabel).toContain('CloudPeak');
  });
});

describe('receivableOpen', () => {
  it('passes the documented cutoff', async () => {
    await ADMIN_ALERT_FINDERS.receivableOpen({ now: NOW, limit: LIMIT });
    expect(mockListOpen).toHaveBeenCalledWith(
      new Date(NOW.getTime() - RECEIVABLE_OPEN_CUTOFF_MS),
      LIMIT
    );
  });

  it('folds multiple receivables for the same company into ONE company-grained finding', async () => {
    mockListOpen.mockResolvedValue([
      {
        receivableId: 'r1',
        companyId: 'company_1',
        companyName: 'Northwind Industrial',
        amountMinor: 5000,
        reason: 'settlement_declined',
        openedAt: new Date('2026-09-01T00:00:00.000Z'),
        lastDunningAt: null,
        stripePaymentIntentId: null,
      },
      {
        receivableId: 'r2',
        companyId: 'company_1',
        companyName: 'Northwind Industrial',
        amountMinor: 1240,
        reason: 'settlement_declined',
        openedAt: new Date('2026-09-03T00:00:00.000Z'),
        lastDunningAt: null,
        stripePaymentIntentId: null,
      },
    ]);

    const outcome = await ADMIN_ALERT_FINDERS.receivableOpen({ now: NOW, limit: LIMIT });

    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('company');
    expect(finding?.entityId).toBe('company_1');
    expect(finding?.detail.evidence).toContain('A$62.40');
  });

  it('reports batchFilled when the read fills its limit', async () => {
    mockListOpen.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({
        receivableId: `r${i}`,
        companyId: `company_${i}`,
        companyName: 'Co',
        amountMinor: 100,
        reason: 'settlement_declined',
        openedAt: NOW,
        lastDunningAt: null,
        stripePaymentIntentId: null,
      }))
    );
    const outcome = await ADMIN_ALERT_FINDERS.receivableOpen({ now: NOW, limit: LIMIT });
    expect(outcome.batchFilled).toBe(true);
  });

  it('A-F8: marks the count and total as a LOWER BOUND ("+") when the batch filled — even for a company with one row', async () => {
    mockListOpen.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({
        receivableId: `r${i}`,
        companyId: `company_${i}`,
        companyName: 'Co',
        amountMinor: 100,
        reason: 'settlement_declined',
        openedAt: NOW,
        lastDunningAt: null,
        stripePaymentIntentId: null,
      }))
    );
    const outcome = await ADMIN_ALERT_FINDERS.receivableOpen({ now: NOW, limit: LIMIT });
    const [finding] = outcome.findings;
    // Each company here has exactly ONE receivable, which would normally render the
    // singular "has an open receivable" — batchFilled overrides that to the "1+" form,
    // because a truncated read cannot vouch that this company's set is complete either.
    expect(finding?.detail.title).toContain('1+ open receivables');
    expect(finding?.detail.evidence).toContain('A$1.00+ owed across 1+ receivable');
    const countFact = finding?.detail.facts.find(([label]) => label === 'Receivable count');
    expect(countFact?.[1]).toBe('1+');
  });

  it('does NOT mark the count as a lower bound when the batch did not fill', async () => {
    mockListOpen.mockResolvedValue([
      {
        receivableId: 'r1',
        companyId: 'company_1',
        companyName: 'Northwind Industrial',
        amountMinor: 5000,
        reason: 'settlement_declined',
        openedAt: NOW,
        lastDunningAt: null,
        stripePaymentIntentId: null,
      },
    ]);
    const outcome = await ADMIN_ALERT_FINDERS.receivableOpen({ now: NOW, limit: LIMIT });
    const [finding] = outcome.findings;
    expect(finding?.detail.title).toBe('Northwind Industrial has an open receivable');
    expect(finding?.detail.title).not.toContain('+');
    const countFact = finding?.detail.facts.find(([label]) => label === 'Receivable count');
    expect(countFact?.[1]).toBe('1');
  });
});

describe('sessionSettledNoLedgerCredit', () => {
  it('passes the documented cutoff — MUST match credit-session-meter-sweep.ts (60 minutes)', async () => {
    await ADMIN_ALERT_FINDERS.sessionSettledNoLedgerCredit({ now: NOW, limit: LIMIT });
    expect(SESSION_SETTLED_NO_LEDGER_CREDIT_CUTOFF_MS).toBe(60 * 60 * 1000);
    expect(mockFindSettledMissingLedgerCredit).toHaveBeenCalledWith(
      new Date(NOW.getTime() - SESSION_SETTLED_NO_LEDGER_CREDIT_CUTOFF_MS),
      LIMIT
    );
  });

  it('produces a session-grained finding carrying the meeting id as targetId', async () => {
    mockFindSettledMissingLedgerCredit.mockResolvedValue([
      {
        id: 'session_1',
        walletId: 'wallet_1',
        companyId: 'company_1',
        settledAt: NOW,
        overdraftSettledMinor: 1200,
        stripePaymentIntentId: 'pi_1',
        meetingId: 'meeting_1',
      },
    ]);

    const outcome = await ADMIN_ALERT_FINDERS.sessionSettledNoLedgerCredit({
      now: NOW,
      limit: LIMIT,
    });

    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('session');
    expect(finding?.entityId).toBe('session_1');
    expect(finding?.detail.targetId).toBe('meeting_1');
  });
});

describe('recordingFailed', () => {
  it('passes the documented cutoff and carries the meeting id as targetId', async () => {
    mockListFailedSinceRecordings.mockResolvedValue([
      {
        recordingId: 'rec_1',
        meetingId: 'meeting_1',
        meetingScheduledStart: NOW,
        failedStage: 'ingest',
        failureReason: 'timeout',
        dailyRecordingId: null,
        muxAssetId: null,
        createdAt: NOW,
        captureEndedAt: null,
      },
    ]);
    const outcome = await ADMIN_ALERT_FINDERS.recordingFailed({ now: NOW, limit: LIMIT });
    expect(mockListFailedSinceRecordings).toHaveBeenCalledWith(
      new Date(NOW.getTime() - RECORDING_FAILED_CUTOFF_MS),
      LIMIT
    );
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('recording');
    expect(finding?.entityId).toBe('rec_1');
    expect(finding?.detail.targetId).toBe('meeting_1');
  });

  it('A-F5: sanitizes a URL-shaped failureReason before it reaches evidence/facts', async () => {
    mockListFailedSinceRecordings.mockResolvedValue([
      {
        recordingId: 'rec_2',
        meetingId: 'meeting_2',
        meetingScheduledStart: NOW,
        failedStage: 'ingest',
        failureReason: '400 {"invalid_parameters":["https://daily.co/secret-token?x=1"]}',
        dailyRecordingId: null,
        muxAssetId: null,
        createdAt: NOW,
        captureEndedAt: null,
      },
    ]);
    const outcome = await ADMIN_ALERT_FINDERS.recordingFailed({ now: NOW, limit: LIMIT });
    const [finding] = outcome.findings;
    expect(finding?.detail.evidence).not.toContain('https://daily.co/secret-token');
    expect(finding?.detail.evidence).toContain('[redacted-url]');
    const failureReasonFact = finding?.detail.facts.find(([label]) => label === 'Failure reason');
    expect(failureReasonFact?.[1]).not.toContain('https://daily.co/secret-token');
    expect(failureReasonFact?.[1]).toContain('[redacted-url]');
  });
});

describe('transcriptFailed', () => {
  it('passes the documented cutoff and carries the meeting id as targetId', async () => {
    mockListFailedSinceTranscripts.mockResolvedValue([
      {
        transcriptId: 'transcript_1',
        meetingId: 'meeting_1',
        meetingScheduledStart: NOW,
        failedStage: 'diarize',
        failureReason: 'vendor 500',
        createdAt: NOW,
      },
    ]);
    const outcome = await ADMIN_ALERT_FINDERS.transcriptFailed({ now: NOW, limit: LIMIT });
    expect(mockListFailedSinceTranscripts).toHaveBeenCalledWith(
      new Date(NOW.getTime() - TRANSCRIPT_FAILED_CUTOFF_MS),
      LIMIT
    );
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('transcript');
    expect(finding?.entityId).toBe('transcript_1');
    expect(finding?.detail.targetId).toBe('meeting_1');
  });

  it('A-F5: sanitizes a URL-shaped failureReason before it reaches evidence/facts', async () => {
    mockListFailedSinceTranscripts.mockResolvedValue([
      {
        transcriptId: 'transcript_2',
        meetingId: 'meeting_2',
        meetingScheduledStart: NOW,
        failedStage: 'diarize',
        failureReason: '400 {"invalid_parameters":["https://daily.co/secret-token?x=1"]}',
        createdAt: NOW,
      },
    ]);
    const outcome = await ADMIN_ALERT_FINDERS.transcriptFailed({ now: NOW, limit: LIMIT });
    const [finding] = outcome.findings;
    expect(finding?.detail.evidence).not.toContain('https://daily.co/secret-token');
    expect(finding?.detail.evidence).toContain('[redacted-url]');
    const failureReasonFact = finding?.detail.facts.find(([label]) => label === 'Failure reason');
    expect(failureReasonFact?.[1]).not.toContain('https://daily.co/secret-token');
    expect(failureReasonFact?.[1]).toContain('[redacted-url]');
  });
});

describe('transcriptCaptureWithheldSource', () => {
  it('passes the documented 24h cutoff and carries the meeting id as targetId', async () => {
    mockListWithheldTranscriptSourceSince.mockResolvedValue([
      {
        recordingId: 'rec_1',
        meetingId: 'meeting_1',
        meetingScheduledStart: NOW,
        transcriptJobId: 'job_1',
        transcriptJobSubmittedAt: NOW,
        dailyRecordingId: null,
        readyAt: null,
      },
    ]);
    const outcome = await ADMIN_ALERT_FINDERS.transcriptCaptureWithheldSource({
      now: NOW,
      limit: LIMIT,
    });
    expect(mockListWithheldTranscriptSourceSince).toHaveBeenCalledWith(
      new Date(NOW.getTime() - TRANSCRIPT_CAPTURE_WITHHELD_SOURCE_CUTOFF_MS),
      LIMIT
    );
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('recording');
    expect(finding?.detail.targetId).toBe('meeting_1');
  });
});

describe('calendarSubscriptionLapse', () => {
  it('is skipped with zero repository calls when APIROC_WEBHOOK_BASE_URL is unset', async () => {
    const outcome = await ADMIN_ALERT_FINDERS.calendarSubscriptionLapse({ now: NOW, limit: LIMIT });
    expect(outcome.skipped).toBe('feature_disabled');
    expect(outcome.findings).toEqual([]);
    expect(mockListExpiringBefore).not.toHaveBeenCalled();
    expect(mockListUnconfirmedBefore).not.toHaveBeenCalled();
    expect(mockListActiveConnectionsWithoutSubscription).not.toHaveBeenCalled();
    expect(mockListConnectionAlertLabels).not.toHaveBeenCalled();
  });

  it('dedups a connection hit by multiple arms into ONE finding', async () => {
    process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
    mockListExpiringBefore.mockResolvedValue([{ connectionId: 'conn_1' }]);
    mockListUnconfirmedBefore.mockResolvedValue([{ connectionId: 'conn_1' }]);
    mockListActiveConnectionsWithoutSubscription.mockResolvedValue([]);
    mockListConnectionAlertLabels.mockResolvedValue(
      new Map([
        [
          'conn_1',
          {
            connectionId: 'conn_1',
            expertProfileId: 'expert_1',
            userFirstName: 'Marcus',
            userLastName: 'Lee',
            agencyName: null,
            provider: 'google',
            connectionCreatedAt: NOW,
          },
        ],
      ])
    );

    const outcome = await ADMIN_ALERT_FINDERS.calendarSubscriptionLapse({ now: NOW, limit: LIMIT });

    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('calendar');
    expect(finding?.entityId).toBe('conn_1');
    expect(finding?.detail.evidence).toContain('expiring');
    expect(finding?.detail.evidence).toContain('never confirmed');
  });

  it('drops a connection missing from the hydration Map without throwing', async () => {
    process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
    mockListExpiringBefore.mockResolvedValue([{ connectionId: 'conn_gone' }]);
    mockListConnectionAlertLabels.mockResolvedValue(new Map());

    const outcome = await ADMIN_ALERT_FINDERS.calendarSubscriptionLapse({ now: NOW, limit: LIMIT });
    expect(outcome.findings).toEqual([]);
  });

  it('reports batchFilled when any arm fills its limit', async () => {
    process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
    mockListExpiringBefore.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({ connectionId: `conn_${i}` }))
    );
    const outcome = await ADMIN_ALERT_FINDERS.calendarSubscriptionLapse({ now: NOW, limit: LIMIT });
    expect(outcome.batchFilled).toBe(true);
  });
});

/**
 * BAL-581 — the SAME bounded read the venue repair producer uses, called INDEPENDENTLY (a
 * finder never enqueues, ADR-1055 — the `calendarSubscriptionLapse` precedent above).
 */
describe('meetingUnprovisioned', () => {
  it('passes scheduledStartAfter = now − missedCallTerminationMs, createdBefore = now − the grace, and the limit', async () => {
    await ADMIN_ALERT_FINDERS.meetingUnprovisioned({ now: NOW, limit: LIMIT });

    expect(mockListUnprovisionedScheduled).toHaveBeenCalledWith({
      scheduledStartAfter: new Date(NOW.getTime() - 10 * 60_000),
      createdBefore: new Date(NOW.getTime() - MEETING_UNPROVISIONED_GRACE_MS),
      limit: LIMIT,
    });
  });

  it('maps a room that was never created', async () => {
    mockListUnprovisionedScheduled.mockResolvedValue([
      { meetingId: 'meeting_1', scheduledStart: NOW, createdAt: NOW, roomNameStamped: false },
    ]);

    const outcome = await ADMIN_ALERT_FINDERS.meetingUnprovisioned({ now: NOW, limit: LIMIT });

    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.entityType).toBe('meeting');
    expect(finding?.entityId).toBe('meeting_1');
    expect(finding?.detail.evidence).toContain('never created');
    expect(finding?.detail.facts).toHaveLength(4);
    expect(finding?.detail.facts.find(([label]) => label === 'Room')?.[1]).toBe('never created');
  });

  it('maps a stamped-but-MISMATCHED room name distinctly from a never-created one', async () => {
    mockListUnprovisionedScheduled.mockResolvedValue([
      { meetingId: 'meeting_2', scheduledStart: NOW, createdAt: NOW, roomNameStamped: true },
    ]);

    const outcome = await ADMIN_ALERT_FINDERS.meetingUnprovisioned({ now: NOW, limit: LIMIT });

    const [finding] = outcome.findings;
    expect(finding?.detail.evidence).toContain('name does not match');
    expect(finding?.detail.facts.find(([label]) => label === 'Room')?.[1]).toBe('name mismatch');
  });

  it('reports batchFilled at the limit', async () => {
    mockListUnprovisionedScheduled.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({
        meetingId: `meeting_${i}`,
        scheduledStart: NOW,
        createdAt: NOW,
        roomNameStamped: false,
      }))
    );

    const outcome = await ADMIN_ALERT_FINDERS.meetingUnprovisioned({ now: NOW, limit: LIMIT });

    expect(outcome.batchFilled).toBe(true);
  });

  it('carries no join URL and no room name — not in the row by construction', async () => {
    mockListUnprovisionedScheduled.mockResolvedValue([
      { meetingId: 'meeting_1', scheduledStart: NOW, createdAt: NOW, roomNameStamped: false },
    ]);

    const outcome = await ADMIN_ALERT_FINDERS.meetingUnprovisioned({ now: NOW, limit: LIMIT });

    const [finding] = outcome.findings;
    const values = finding?.detail.facts.map(([, value]) => value).join(' ') ?? '';
    expect(values).not.toContain('daily.co');
    expect(values).not.toContain('balo-');
  });
});

describe('meetingStranded', () => {
  const strandedRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    meetingId: 'm1',
    status: 'in_progress',
    scheduledStart: new Date('2026-09-08T09:00:00.000Z'),
    scheduledEnd: new Date('2026-09-08T10:00:00.000Z'),
    openIntervalCount: 2,
    openBillableIntervalCount: 2,
    oldestOpenJoinedAt: new Date('2026-09-08T09:05:00.000Z'),
    ...overrides,
  });
  const emptyRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    strandedRow({
      openIntervalCount: 0,
      openBillableIntervalCount: 0,
      oldestOpenJoinedAt: null,
      ...overrides,
    });

  async function evidenceOf(row: Record<string, unknown>): Promise<string | undefined> {
    mockListStrandedLive.mockResolvedValue([row]);
    const { findings } = await ADMIN_ALERT_FINDERS.meetingStranded({ now: NOW, limit: LIMIT });
    return findings[0]?.detail.evidence;
  }

  it('passes the end cutoff and the forced-stop ceiling cutoff, and reports batchFilled at the limit', async () => {
    mockListStrandedLive.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => strandedRow({ meetingId: `m${i}` }))
    );

    const outcome = await ADMIN_ALERT_FINDERS.meetingStranded({ now: NOW, limit: LIMIT });

    // The mocked timers carry overrunStopGraceMs = 30 min.
    expect(mockListStrandedLive).toHaveBeenCalledWith({
      scheduledEndBefore: new Date(NOW.getTime() - MEETING_STRANDED_AFTER_END_MS),
      liveCeilingBefore: new Date(NOW.getTime() - 30 * 60_000 - MEETING_STRANDED_PAST_STOP_MS),
      limit: LIMIT,
    });
    expect(MEETING_STRANDED_AFTER_END_MS).toBe(60 * 60_000);
    expect(MEETING_STRANDED_PAST_STOP_MS).toBe(10 * 60_000);
    expect(PRESENCE_OVERRUN_MARGIN_MINUTES).toBe(30);
    expect(PRESENCE_UNSETTLED_ALERT_MS).toBe(30 * 60_000);
    expect(outcome.batchFilled).toBe(true);
    expect(outcome.findings).toHaveLength(LIMIT);
  });

  it('produces no findings for an empty read', async () => {
    const outcome = await ADMIN_ALERT_FINDERS.meetingStranded({ now: NOW, limit: LIMIT });
    expect(outcome.findings).toEqual([]);
    expect(outcome.batchFilled).toBe(false);
  });

  it('an occupied in_progress meeting is a forced-stop overrun that is still drawing credit', async () => {
    mockListStrandedLive.mockResolvedValue([strandedRow()]);
    const [finding] = (await ADMIN_ALERT_FINDERS.meetingStranded({ now: NOW, limit: LIMIT }))
      .findings;

    expect(finding).toMatchObject({ entityType: 'meeting', entityId: 'm1' });
    expect(finding?.detail.title).toBe('Live meeting ran past its forced stop');
    expect(finding?.detail.evidence).toContain('Still in progress 2 h after its scheduled end');
    expect(finding?.detail.evidence).toContain('2 participants still show as connected');
    expect(finding?.detail.evidence).toContain('still drawing credit every minute');
    expect(finding?.detail.evidence).toContain('Until an admin end action exists');
    expect(finding?.detail.facts).toContainEqual(['Open presence intervals', '2']);
    expect(finding?.detail.facts).toContainEqual(['Past sweep lookback', 'no']);
  });

  it('words each status by what it is, with a humanized overdue duration', async () => {
    expect(await evidenceOf(emptyRow({ status: 'scheduled' }))).toContain(
      'Never started and is still marked scheduled 2 h after its scheduled end; nobody is connected'
    );
    expect(await evidenceOf(emptyRow({ status: 'waiting_for_participants' }))).toContain(
      'Still waiting for participants 2 h after its scheduled end'
    );
    expect(
      await evidenceOf(
        emptyRow({
          scheduledStart: new Date('2026-09-05T09:00:00.000Z'),
          scheduledEnd: new Date('2026-09-05T10:00:00.000Z'),
        })
      )
    ).toContain('Still in progress 3 days after its scheduled end');
    expect(
      await evidenceOf(emptyRow({ scheduledEnd: new Date('2026-09-08T10:55:00.000Z') }))
    ).toContain('Still in progress 1 h 5 min after its scheduled end');
  });

  it('an unoccupied meeting keeps the never-ended title and says nobody is connected', async () => {
    mockListStrandedLive.mockResolvedValue([emptyRow()]);
    const [finding] = (await ADMIN_ALERT_FINDERS.meetingStranded({ now: NOW, limit: LIMIT }))
      .findings;
    expect(finding?.detail.title).toBe('Live meeting was never ended');
    expect(finding?.detail.evidence).toContain('nobody is connected');
    expect(finding?.detail.evidence).not.toContain('drawing credit');
    expect(finding?.detail.evidence).toContain('Until an admin end action exists');
  });

  it('a past-lookback start is flagged', async () => {
    mockListStrandedLive.mockResolvedValue([
      emptyRow({
        scheduledStart: new Date('2026-09-05T09:00:00.000Z'),
        scheduledEnd: new Date('2026-09-05T10:00:00.000Z'),
      }),
    ]);
    const { findings } = await ADMIN_ALERT_FINDERS.meetingStranded({ now: NOW, limit: LIMIT });
    expect(findings[0]?.detail.facts).toContainEqual(['Past sweep lookback', 'yes']);
  });

  it('agrees singular subject and verb', async () => {
    const evidence = await evidenceOf(
      strandedRow({ openIntervalCount: 1, openBillableIntervalCount: 1 })
    );
    expect(evidence).toContain('1 participant still shows as connected');
  });

  it('names observers and drops the credit claim when only observers are connected', async () => {
    const mixed = await evidenceOf(
      strandedRow({ openIntervalCount: 3, openBillableIntervalCount: 1 })
    );
    expect(mixed).toContain('3 participants (incl. 2 observers) still show as connected');
    expect(mixed).toContain('still drawing credit every minute');

    const observersOnly = await evidenceOf(
      strandedRow({ openIntervalCount: 1, openBillableIntervalCount: 0 })
    );
    expect(observersOnly).toContain('1 participant (incl. 1 observer) still shows as connected');
    expect(observersOnly).not.toContain('drawing credit');
  });
});

describe('sessionPresenceStuck', () => {
  const label = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    sessionId: 's1',
    meetingId: 'm1',
    companyName: 'Northwind',
    connectedMinutes: 100,
    estimatedMinutes: 60,
    meetingScheduledStart: new Date('2026-09-08T09:00:00.000Z'),
    meetingStatus: 'in_progress',
    meetingEndedAt: null,
    creditDrawnMinor: 12_000,
    settlementExhausted: false,
    exhaustionGuard: null,
    ...overrides,
  });
  const overrunRow = {
    sessionId: 's1',
    meetingId: 'm1',
    connectedMinutes: 100,
    estimatedMinutes: 60,
  };
  const unsettledRow = { id: 's1' };

  it('passes the margin and the unsettled cutoff, and reports batchFilled when either arm fills', async () => {
    mockListPresenceOverrunning.mockResolvedValue([]);
    mockFindPresenceUnsettled.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({ id: `s${i}` }))
    );

    const outcome = await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT });

    expect(mockListPresenceOverrunning).toHaveBeenCalledWith({
      marginMinutes: PRESENCE_OVERRUN_MARGIN_MINUTES,
      limit: LIMIT,
    });
    expect(mockFindPresenceUnsettled).toHaveBeenCalledWith(
      new Date(NOW.getTime() - PRESENCE_UNSETTLED_ALERT_MS),
      LIMIT
    );
    expect(outcome.batchFilled).toBe(true);

    mockFindPresenceUnsettled.mockResolvedValue([]);
    mockListPresenceOverrunning.mockResolvedValue(
      Array.from({ length: LIMIT }, (_, i) => ({ ...overrunRow, sessionId: `s${i}` }))
    );
    expect(
      (await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT })).batchFilled
    ).toBe(true);

    mockListPresenceOverrunning.mockResolvedValue([overrunRow]);
    expect(
      (await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT })).batchFilled
    ).toBe(false);
  });

  it('produces one finding with the same entityId for the overrunning arm alone and for both arms', async () => {
    mockListPresenceOverrunning.mockResolvedValue([overrunRow]);
    mockListPresenceAlertLabels.mockResolvedValue(new Map([['s1', label()]]));
    const overrunOnly = await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT });

    mockFindPresenceUnsettled.mockResolvedValue([unsettledRow]);
    mockListPresenceAlertLabels.mockResolvedValue(
      new Map([
        [
          's1',
          label({ meetingStatus: 'ended', meetingEndedAt: new Date('2026-09-08T10:00:00.000Z') }),
        ],
      ])
    );
    const both = await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT });

    expect(overrunOnly.findings).toHaveLength(1);
    expect(both.findings).toHaveLength(1);
    expect(both.findings[0]?.entityId).toBe(overrunOnly.findings[0]?.entityId);
    expect(mockListPresenceAlertLabels).toHaveBeenLastCalledWith(['s1']);
    expect(overrunOnly.findings[0]?.detail.title).toBe(
      "Northwind's consultation is still drawing credit past its estimate"
    );
    expect(overrunOnly.findings[0]?.detail.evidence).toBe(
      '100 connected minutes against an estimate of 60'
    );
    expect(both.findings[0]?.detail.title).toBe("Northwind's consultation ended but never settled");
    expect(both.findings[0]?.detail.evidence).toContain(
      '100 connected minutes against an estimate of 60; the meeting ended'
    );
    expect(both.findings[0]).toMatchObject({ entityType: 'session', targetId: 'm1' });
    expect(both.findings[0]?.detail.facts).toContainEqual(['Arms', 'overrunning, unsettled']);
    expect(both.findings[0]?.detail.facts).toContainEqual(['Credit drawn', 'A$120.00']);
  });

  it('drops a session missing from the label hydration', async () => {
    mockListPresenceOverrunning.mockResolvedValue([overrunRow]);
    const outcome = await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT });
    expect(outcome.findings).toEqual([]);
  });

  it('a refused session carries the guard and the runbook path', async () => {
    mockFindPresenceUnsettled.mockResolvedValue([unsettledRow]);
    mockListPresenceAlertLabels.mockResolvedValue(
      new Map([
        [
          's1',
          label({
            settlementExhausted: true,
            exhaustionGuard: 'figure_exceeds_bound',
            meetingStatus: 'ended',
            meetingEndedAt: new Date('2026-09-08T10:00:00.000Z'),
          }),
        ],
      ])
    );
    const [finding] = (await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT }))
      .findings;

    expect(finding?.detail.title).toBe("Settlement refused for Northwind's consultation");
    expect(finding?.detail.evidence).toContain('refused this session permanently');
    expect(finding?.detail.evidence).toContain('figure_exceeds_bound');
    expect(finding?.detail.evidence).toContain(PRESENCE_SETTLEMENT_EXHAUSTED_RUNBOOK);
    expect(finding?.detail.facts).toContainEqual(['Settlement refused', 'figure_exceeds_bound']);
  });

  it('an unmarked session mentions neither refusal nor the runbook', async () => {
    mockListPresenceOverrunning.mockResolvedValue([overrunRow]);
    mockListPresenceAlertLabels.mockResolvedValue(new Map([['s1', label()]]));
    const [finding] = (await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT }))
      .findings;

    expect(finding?.detail.evidence).not.toContain('refused');
    expect(finding?.detail.evidence).not.toContain(PRESENCE_SETTLEMENT_EXHAUSTED_RUNBOOK);
    expect(finding?.detail.facts.map(([key]) => key)).not.toContain('Settlement refused');
  });

  it('falls back to an unknown guard when the marker carries none', async () => {
    mockFindPresenceUnsettled.mockResolvedValue([unsettledRow]);
    mockListPresenceAlertLabels.mockResolvedValue(
      new Map([['s1', label({ settlementExhausted: true, exhaustionGuard: null })]])
    );
    const [finding] = (await ADMIN_ALERT_FINDERS.sessionPresenceStuck({ now: NOW, limit: LIMIT }))
      .findings;
    expect(finding?.detail.evidence).toContain('unknown guard');
    expect(finding?.detail.facts).toContainEqual(['Settlement refused', 'unknown guard']);
  });
});
