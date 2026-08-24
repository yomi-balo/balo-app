import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const {
  mockPropose,
  mockWithdraw,
  mockDecline,
  mockAccept,
  mockRevertAccept,
  mockCancelScheduledNotification,
  mockScheduleRescheduleProposalReminder,
  mockRescheduleMeeting,
} = vi.hoisted(() => ({
  mockPropose: vi.fn(),
  mockWithdraw: vi.fn(),
  mockDecline: vi.fn(),
  mockAccept: vi.fn(),
  mockRevertAccept: vi.fn(),
  mockCancelScheduledNotification: vi.fn(),
  mockScheduleRescheduleProposalReminder: vi.fn(),
  mockRescheduleMeeting: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  rescheduleProposalsRepository: {
    propose: mockPropose,
    withdraw: mockWithdraw,
    decline: mockDecline,
    accept: mockAccept,
    revertAccept: mockRevertAccept,
  },
}));
vi.mock('../../notifications/scheduling/schedule.js', () => ({
  cancelScheduledNotification: mockCancelScheduledNotification,
}));
vi.mock('../../notifications/scheduling/reschedule-proposal.js', () => ({
  rescheduleProposalUnansweredKey: (proposalId: string) =>
    `reschedule_proposal_unanswered:${proposalId}`,
  scheduleRescheduleProposalReminder: mockScheduleRescheduleProposalReminder,
}));
vi.mock('./meeting-availability.js', () => ({
  rescheduleMeeting: mockRescheduleMeeting,
}));

import {
  acceptRescheduleProposal,
  declineRescheduleProposal,
  proposeReschedule,
  withdrawRescheduleProposal,
} from './reschedule-proposals.js';

const PROPOSAL_ID = 'proposal-1';
const MEETING_ID = 'meeting-1';
const ENGAGEMENT_ID = 'engagement-1';
const COMPANY_ID = 'company-1';
const USER_ID = 'user-1';
const OPTION_ID = 'option-1';
const NOW = new Date('2026-08-24T10:00:00.000Z');
const AUDIT_ID = 'audit-1';

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('proposeReschedule — T-SVC-1', () => {
  const ORIGINAL_START = new Date('2026-09-10T10:00:00.000Z');

  it('proposes and arms the reminder in one call, both threaded the SAME tx', async () => {
    mockPropose.mockResolvedValue({
      proposal: { id: PROPOSAL_ID },
      options: [{ id: 'o1' }, { id: 'o2' }],
    });

    const result = await proposeReschedule(
      {
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertPartyLabel: 'CloudPeak',
        caseTitle: 'Salesforce cleanup',
        proposedByUserId: USER_ID,
        originalScheduledStart: ORIGINAL_START,
        options: [
          {
            scheduledStart: new Date('2026-09-12T10:00:00.000Z'),
            scheduledEnd: new Date('2026-09-12T11:00:00.000Z'),
          },
        ],
        now: NOW,
      },
      log
    );

    expect(result.proposal.id).toBe(PROPOSAL_ID);
    expect(mockPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        proposedByUserId: USER_ID,
        originalScheduledStart: ORIGINAL_START,
        // The deadline IS the original start.
        expiresAt: ORIGINAL_START,
      }),
      NOW,
      expect.anything()
    );
    expect(mockScheduleRescheduleProposalReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        optionCount: 2,
      }),
      expect.anything()
    );
  });

  it('propagates RescheduleProposalAlreadyPendingError uncaught (the route maps it)', async () => {
    class RescheduleProposalAlreadyPendingError extends Error {}
    mockPropose.mockRejectedValue(new RescheduleProposalAlreadyPendingError('already pending'));

    await expect(
      proposeReschedule(
        {
          meetingId: MEETING_ID,
          engagementId: ENGAGEMENT_ID,
          companyId: COMPANY_ID,
          expertPartyLabel: 'CloudPeak',
          caseTitle: 'Salesforce cleanup',
          proposedByUserId: USER_ID,
          originalScheduledStart: ORIGINAL_START,
          options: [{ scheduledStart: ORIGINAL_START, scheduledEnd: ORIGINAL_START }],
          now: NOW,
        },
        log
      )
    ).rejects.toThrow(RescheduleProposalAlreadyPendingError);
    expect(mockScheduleRescheduleProposalReminder).not.toHaveBeenCalled();
  });
});

describe('withdrawRescheduleProposal — T-SVC-2', () => {
  it('withdraws and cancels the reminder together', async () => {
    mockWithdraw.mockResolvedValue({ id: PROPOSAL_ID, status: 'withdrawn' });

    const result = await withdrawRescheduleProposal(
      { proposalId: PROPOSAL_ID, meetingId: MEETING_ID, actorUserId: USER_ID, now: NOW },
      log
    );

    expect(result).toMatchObject({ id: PROPOSAL_ID });
    expect(mockCancelScheduledNotification).toHaveBeenCalledWith(
      'reschedule_proposal_unanswered:proposal-1',
      expect.anything()
    );
  });

  it('a lost CAS returns undefined and never cancels the reminder', async () => {
    mockWithdraw.mockResolvedValue(undefined);

    const result = await withdrawRescheduleProposal(
      { proposalId: PROPOSAL_ID, meetingId: MEETING_ID, actorUserId: USER_ID, now: NOW },
      log
    );

    expect(result).toBeUndefined();
    expect(mockCancelScheduledNotification).not.toHaveBeenCalled();
  });
});

describe('declineRescheduleProposal — T-SVC-3', () => {
  it('declines and cancels the reminder together', async () => {
    mockDecline.mockResolvedValue({ id: PROPOSAL_ID, status: 'declined' });

    const result = await declineRescheduleProposal(
      { proposalId: PROPOSAL_ID, meetingId: MEETING_ID, actorUserId: USER_ID, now: NOW },
      log
    );

    expect(result).toMatchObject({ id: PROPOSAL_ID });
    expect(mockCancelScheduledNotification).toHaveBeenCalled();
  });

  it('a lost CAS returns undefined', async () => {
    mockDecline.mockResolvedValue(undefined);

    const result = await declineRescheduleProposal(
      { proposalId: PROPOSAL_ID, meetingId: MEETING_ID, actorUserId: USER_ID, now: NOW },
      log
    );

    expect(result).toBeUndefined();
    expect(mockCancelScheduledNotification).not.toHaveBeenCalled();
  });
});

describe('acceptRescheduleProposal — T-SVC-4', () => {
  const NEW_START = new Date('2026-09-12T10:00:00.000Z');
  const NEW_END = new Date('2026-09-12T11:00:00.000Z');
  const ORIGINAL_START = new Date('2026-09-01T10:00:00.000Z');

  function acceptInput() {
    return {
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      actorUserId: USER_ID,
      optionId: OPTION_ID,
      scheduledStart: NEW_START,
      scheduledEnd: NEW_END,
      now: NOW,
    };
  }

  it('a lost CAS returns undefined and never calls rescheduleMeeting', async () => {
    mockAccept.mockResolvedValue(undefined);

    const result = await acceptRescheduleProposal(acceptInput(), log);

    expect(result).toBeUndefined();
    expect(mockRescheduleMeeting).not.toHaveBeenCalled();
    expect(mockCancelScheduledNotification).not.toHaveBeenCalled();
  });

  it('happy path: CAS, cancel the reminder, THEN move the meeting — in that order', async () => {
    mockAccept.mockResolvedValue({
      proposal: { id: PROPOSAL_ID, originalScheduledStart: ORIGINAL_START },
      option: { id: OPTION_ID },
    });
    mockRescheduleMeeting.mockResolvedValue({
      meeting: { scheduledStart: NEW_START, scheduledEnd: NEW_END },
      previous: {
        scheduledStart: new Date('2026-09-01T10:00:00.000Z'),
        scheduledEnd: new Date('2026-09-01T11:00:00.000Z'),
      },
      rescheduleAuditId: AUDIT_ID,
    });

    const result = await acceptRescheduleProposal(acceptInput(), log);

    expect(mockCancelScheduledNotification).toHaveBeenCalled();
    expect(mockRescheduleMeeting).toHaveBeenCalledWith(
      MEETING_ID,
      { scheduledStart: NEW_START, scheduledEnd: NEW_END },
      USER_ID,
      log
    );
    expect(result).toEqual({
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      scheduledStart: NEW_START,
      scheduledEnd: NEW_END,
      previousScheduledStart: new Date('2026-09-01T10:00:00.000Z'),
      previousScheduledEnd: new Date('2026-09-01T11:00:00.000Z'),
      rescheduleAuditId: AUDIT_ID,
    });
    expect(mockRevertAccept).not.toHaveBeenCalled();
  });

  it('a meeting-move failure reverts the CAS and RE-THROWS — never the reverse ordering', async () => {
    mockAccept.mockResolvedValue({
      proposal: { id: PROPOSAL_ID, originalScheduledStart: ORIGINAL_START },
      option: { id: OPTION_ID },
    });
    const moveError = new Error('meeting is not reschedulable');
    mockRescheduleMeeting.mockRejectedValue(moveError);
    mockRevertAccept.mockResolvedValue({ id: PROPOSAL_ID, status: 'pending' });

    await expect(acceptRescheduleProposal(acceptInput(), log)).rejects.toThrow(moveError);

    expect(mockRevertAccept).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      expectedOriginalScheduledStart: ORIGINAL_START,
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('a revert that finds nothing to revert still re-throws and logs (best-effort)', async () => {
    mockAccept.mockResolvedValue({
      proposal: { id: PROPOSAL_ID, originalScheduledStart: ORIGINAL_START },
      option: { id: OPTION_ID },
    });
    mockRescheduleMeeting.mockRejectedValue(new Error('boom'));
    mockRevertAccept.mockResolvedValue(undefined);

    await expect(acceptRescheduleProposal(acceptInput(), log)).rejects.toThrow('boom');
    expect(log.error).toHaveBeenCalled();
  });

  // Item 6 — a REJECTING revert must never swallow the original error. Before this fix the
  // revert ran unguarded inside the catch, so its rejection replaced `moveError` and the
  // route's `instanceof MeetingNotReschedulableError` branch never matched.
  it('a REJECTING revert logs BOTH errors and still re-throws the ORIGINAL, never the revert error', async () => {
    mockAccept.mockResolvedValue({
      proposal: { id: PROPOSAL_ID, originalScheduledStart: ORIGINAL_START },
      option: { id: OPTION_ID },
    });
    const moveError = new Error('meeting is not reschedulable');
    const revertError = new Error('revert pool blip');
    mockRescheduleMeeting.mockRejectedValue(moveError);
    mockRevertAccept.mockRejectedValue(revertError);

    await expect(acceptRescheduleProposal(acceptInput(), log)).rejects.toThrow(moveError);

    // Both failures are logged — the revert's own failure AND the original move failure.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'revert pool blip' }),
      expect.stringContaining('revertAccept itself failed')
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'meeting is not reschedulable' }),
      expect.stringContaining('revert ALSO failed')
    );
  });
});
