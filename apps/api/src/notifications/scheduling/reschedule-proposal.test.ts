import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockFindPendingForAnswer,
  mockListAdminUserIds,
  mockScheduleNotification,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockFindPendingForAnswer: vi.fn(),
  mockListAdminUserIds: vi.fn(),
  mockScheduleNotification: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockMeetingFindById },
  rescheduleProposalsRepository: { findPendingForAnswer: mockFindPendingForAnswer },
  partyMembershipsRepository: { listAdminUserIds: mockListAdminUserIds },
}));
vi.mock('./schedule.js', () => ({ scheduleNotification: mockScheduleNotification }));
// `@balo/shared/meetings`'s `resolveRescheduleRefusal` is NOT mocked — the real allow-list is
// what the `meeting_not_reschedulable` test exercises.

import {
  RESCHEDULE_PROPOSAL_UNANSWERED_RECHECK,
  rescheduleProposalUnansweredKey,
  rescheduleProposalUnansweredRecheck,
  scheduleRescheduleProposalReminder,
} from './reschedule-proposal.js';
import type { ScheduleExecutor } from './schedule.js';
import type { ScheduledNotification } from '@balo/db';

// `scheduleNotification` is mocked above, so the exec value is never actually used to run a
// query — but `scheduleRescheduleProposalReminder`'s signature still demands a real
// `ScheduleExecutor` (a Drizzle db/tx type), which a bare `{}` does not structurally satisfy.
const mockExec = {} as unknown as ScheduleExecutor;

const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const CORRELATION_ID = 'c0000000-0000-4000-8000-000000000000';
const ORIGINAL_START = new Date('2026-09-10T10:00:00.000Z');

function row(payload: Record<string, unknown> = {}): ScheduledNotification {
  return {
    id: 'row-1',
    attempts: 1,
    payload: {
      correlationId: CORRELATION_ID,
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      recipientUserIds: [],
      expertPartyLabel: 'CloudPeak',
      caseTitle: 'Salesforce cleanup',
      originalScheduledStartIso: ORIGINAL_START.toISOString(),
      optionCount: 2,
      ...payload,
    },
  } as unknown as ScheduledNotification;
}

describe('rescheduleProposalUnansweredKey', () => {
  it('is one pending promise per proposal', () => {
    expect(rescheduleProposalUnansweredKey(PROPOSAL_ID)).toBe(
      `reschedule_proposal_unanswered:${PROPOSAL_ID}`
    );
  });
});

describe('rescheduleProposalUnansweredRecheck — T-API-RECHECK-1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindPendingForAnswer.mockResolvedValue({
      proposal: {
        id: PROPOSAL_ID,
        status: 'pending',
        expiresAt: new Date(ORIGINAL_START.getTime() + 1000),
        originalScheduledStart: ORIGINAL_START,
      },
      options: [],
    });
    mockMeetingFindById.mockResolvedValue({
      id: MEETING_ID,
      status: 'scheduled',
      scheduledStart: ORIGINAL_START,
    });
    mockListAdminUserIds.mockResolvedValue(['admin-1']);
  });

  it('skips malformed_payload on a missing proposalId', async () => {
    const result = await rescheduleProposalUnansweredRecheck(row({ proposalId: undefined }));
    expect(result).toEqual({ publish: false, reason: 'malformed_payload' });
  });

  it('skips malformed_payload on a missing companyId', async () => {
    const result = await rescheduleProposalUnansweredRecheck(row({ companyId: '' }));
    expect(result).toEqual({ publish: false, reason: 'malformed_payload' });
  });

  it('skips proposal_missing when the proposal cannot be found', async () => {
    mockFindPendingForAnswer.mockResolvedValue(undefined);
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'proposal_missing' });
  });

  it('skips proposal_answered when status is no longer pending', async () => {
    mockFindPendingForAnswer.mockResolvedValue({
      proposal: {
        id: PROPOSAL_ID,
        status: 'accepted',
        expiresAt: ORIGINAL_START,
        originalScheduledStart: ORIGINAL_START,
      },
      options: [],
    });
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'proposal_answered' });
  });

  it('skips proposal_expired when the deadline has lapsed', async () => {
    mockFindPendingForAnswer.mockResolvedValue({
      proposal: {
        id: PROPOSAL_ID,
        status: 'pending',
        expiresAt: new Date(Date.now() - 1000),
        originalScheduledStart: ORIGINAL_START,
      },
      options: [],
    });
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'proposal_expired' });
  });

  it('skips proposal_missing when the meeting itself cannot be found', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'proposal_missing' });
  });

  it('skips meeting_not_reschedulable when the meeting is no longer live-scheduled', async () => {
    mockMeetingFindById.mockResolvedValue({
      id: MEETING_ID,
      status: 'cancelled',
      scheduledStart: ORIGINAL_START,
    });
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'meeting_not_reschedulable' });
  });

  it('skips proposal_stale when the meeting moved underneath it', async () => {
    mockMeetingFindById.mockResolvedValue({
      id: MEETING_ID,
      status: 'scheduled',
      scheduledStart: new Date(ORIGINAL_START.getTime() + 3600_000),
    });
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'proposal_stale' });
  });

  it('skips no_recipients when the company has no live admin holder', async () => {
    mockListAdminUserIds.mockResolvedValue([]);
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({ publish: false, reason: 'no_recipients' });
  });

  it('publishes with the SPREAD payload + rebuilt recipients — correlationId survives', async () => {
    mockListAdminUserIds.mockResolvedValue(['admin-1', 'admin-2']);
    const result = await rescheduleProposalUnansweredRecheck(row());
    expect(result).toEqual({
      publish: true,
      payload: expect.objectContaining({
        correlationId: CORRELATION_ID,
        proposalId: PROPOSAL_ID,
        recipientUserIds: ['admin-1', 'admin-2'],
      }),
    });
  });
});

describe('scheduleRescheduleProposalReminder — T-API-SCHED-1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScheduleNotification.mockResolvedValue({ outcome: 'scheduled' });
  });

  it('arms the promise 24h before the original start, when that instant is still ahead', async () => {
    const now = new Date(ORIGINAL_START.getTime() - 48 * 3600_000);
    await scheduleRescheduleProposalReminder(
      {
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertPartyLabel: 'CloudPeak',
        caseTitle: 'Salesforce cleanup',
        originalScheduledStart: ORIGINAL_START,
        optionCount: 2,
        now,
      },
      mockExec
    );

    expect(mockScheduleNotification).toHaveBeenCalledWith(
      'reschedule_proposal.unanswered',
      expect.objectContaining({
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        companyId: COMPANY_ID,
        recipientUserIds: [],
      }),
      expect.objectContaining({
        key: rescheduleProposalUnansweredKey(PROPOSAL_ID),
        at: new Date(ORIGINAL_START.getTime() - 24 * 3600_000),
        mode: 'first_wins',
        recheck: RESCHEDULE_PROPOSAL_UNANSWERED_RECHECK,
      }),
      mockExec
    );
  });

  it('does NOT arm the promise once the 24h reminder window has already begun', async () => {
    const now = new Date(ORIGINAL_START.getTime() - 12 * 3600_000);
    await scheduleRescheduleProposalReminder(
      {
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertPartyLabel: 'CloudPeak',
        caseTitle: 'Salesforce cleanup',
        originalScheduledStart: ORIGINAL_START,
        optionCount: 2,
        now,
      },
      mockExec
    );

    expect(mockScheduleNotification).not.toHaveBeenCalled();
  });

  it('does NOT arm exactly at the boundary (fireAt <= now)', async () => {
    const now = new Date(ORIGINAL_START.getTime() - 24 * 3600_000);
    await scheduleRescheduleProposalReminder(
      {
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertPartyLabel: 'CloudPeak',
        caseTitle: 'Salesforce cleanup',
        originalScheduledStart: ORIGINAL_START,
        optionCount: 2,
        now,
      },
      mockExec
    );

    expect(mockScheduleNotification).not.toHaveBeenCalled();
  });

  // CONSIDER item — §D6's central invariant: `correlationId` is a FRESH uuid per schedule
  // call, never stable (never the proposal id) — see the module docblock's own warning. A
  // stable id would make a second, genuine schedule call (landing inside a claim window) a
  // silent BullMQ no-op, since `publisher.publish` derives the jobId from it.
  it('mints a FRESH correlationId per call — two calls never share one, and neither is the proposal id', async () => {
    const now = new Date(ORIGINAL_START.getTime() - 48 * 3600_000);
    const input = {
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertPartyLabel: 'CloudPeak',
      caseTitle: 'Salesforce cleanup',
      originalScheduledStart: ORIGINAL_START,
      optionCount: 2,
      now,
    };

    await scheduleRescheduleProposalReminder(input, mockExec);
    await scheduleRescheduleProposalReminder(input, mockExec);

    const [firstCall, secondCall] = mockScheduleNotification.mock.calls;
    const firstCorrelationId = (firstCall?.[1] as { correlationId?: string })?.correlationId;
    const secondCorrelationId = (secondCall?.[1] as { correlationId?: string })?.correlationId;
    expect(firstCorrelationId).toBeDefined();
    expect(secondCorrelationId).toBeDefined();
    expect(firstCorrelationId).not.toBe(secondCorrelationId);
    expect(firstCorrelationId).not.toBe(PROPOSAL_ID);
    expect(secondCorrelationId).not.toBe(PROPOSAL_ID);
  });
});
