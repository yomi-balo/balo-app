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
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { listPendingApplicationsForAlerts: mockListPendingApplicationsForAlerts },
  creditReceivablesRepository: { listOpen: mockListOpen },
  creditSessionsRepository: { findSettledMissingLedgerCredit: mockFindSettledMissingLedgerCredit },
  meetingRecordingsRepository: {
    listFailedSince: mockListFailedSinceRecordings,
    listWithheldTranscriptSourceSince: mockListWithheldTranscriptSourceSince,
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

import {
  ADMIN_ALERT_FINDERS,
  EXPERT_APPLICATION_PENDING_CUTOFF_MS,
  RECEIVABLE_OPEN_CUTOFF_MS,
  SESSION_SETTLED_NO_LEDGER_CREDIT_CUTOFF_MS,
  RECORDING_FAILED_CUTOFF_MS,
  TRANSCRIPT_FAILED_CUTOFF_MS,
  TRANSCRIPT_CAPTURE_WITHHELD_SOURCE_CUTOFF_MS,
} from './admin-alert-finders.js';

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
