import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: mockAdd })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { dispatch } from './dispatcher.js';
import { getQueue } from '../../lib/queue.js';
import type { NotificationRule, RuleContext } from './rules.js';

describe('dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRule: NotificationRule = {
    channel: 'email',
    recipient: 'self',
    template: 'welcome',
    timing: 'immediate',
  };

  const baseContext: RuleContext = {
    event: 'user.welcome',
    payload: {
      correlationId: 'corr-123',
      userId: 'user-456',
    },
    data: {
      user: { id: 'user-456', email: 'test@example.com' },
    },
  };

  it('adds job to email queue with correct payload and jobId', async () => {
    await dispatch(baseRule, baseContext);

    expect(getQueue).toHaveBeenCalledWith('notification-email');
    expect(mockAdd).toHaveBeenCalledWith(
      'welcome',
      {
        recipientId: 'user-456',
        template: 'welcome',
        event: 'user.welcome',
        data: baseContext.data,
        payload: baseContext.payload,
      },
      expect.objectContaining({
        jobId: 'welcome--user-456--corr-123',
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      })
    );
  });

  it('routes sms channel to notification-sms queue', async () => {
    const smsRule: NotificationRule = {
      ...baseRule,
      channel: 'sms',
      template: 'booking-urgent-sms',
    };

    await dispatch(smsRule, baseContext);

    expect(getQueue).toHaveBeenCalledWith('notification-sms');
  });

  it('routes in-app channel to notification-in-app queue', async () => {
    const inAppRule: NotificationRule = {
      ...baseRule,
      channel: 'in-app',
      template: 'booking-confirmed',
    };

    await dispatch(inAppRule, baseContext);

    expect(getQueue).toHaveBeenCalledWith('notification-in-app');
  });

  it('skips dispatch when condition returns false', async () => {
    const ruleWithCondition: NotificationRule = {
      ...baseRule,
      condition: () => false,
    };

    await dispatch(ruleWithCondition, baseContext);

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('dispatches when condition returns true', async () => {
    const ruleWithCondition: NotificationRule = {
      ...baseRule,
      condition: () => true,
    };

    await dispatch(ruleWithCondition, baseContext);

    expect(mockAdd).toHaveBeenCalledOnce();
  });

  it('warns and skips an admin email when OPS_NOTIFICATION_EMAIL is unset', async () => {
    delete process.env.OPS_NOTIFICATION_EMAIL;
    const adminRule: NotificationRule = {
      ...baseRule,
      recipient: 'admin',
      template: 'project-match-requested',
    };

    await dispatch(adminRule, baseContext);

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('routes an admin email to OPS_NOTIFICATION_EMAIL via recipientEmail', async () => {
    process.env.OPS_NOTIFICATION_EMAIL = 'ops@balo.expert';
    const adminRule: NotificationRule = {
      ...baseRule,
      recipient: 'admin',
      template: 'project-match-requested',
    };
    const matchContext: RuleContext = {
      event: 'project.match_requested',
      payload: { correlationId: 'req-9' },
      data: { company: { name: 'Acme' } },
    };

    await dispatch(adminRule, matchContext);

    expect(getQueue).toHaveBeenCalledWith('notification-email');
    const deliveryPayload = mockAdd.mock.calls[0][1];
    expect(deliveryPayload.recipientEmail).toBe('ops@balo.expert');
    expect(deliveryPayload.recipientId).toBe('ops@balo.expert');
    const opts = mockAdd.mock.calls[0][2];
    expect(opts.jobId).toBe('project-match-requested--ops@balo.expert--req-9');

    delete process.env.OPS_NOTIFICATION_EMAIL;
  });

  it('resolves self recipient to payload.userId', async () => {
    await dispatch(baseRule, baseContext);

    const deliveryPayload = mockAdd.mock.calls[0][1];
    expect(deliveryPayload.recipientId).toBe('user-456');
  });

  it('resolves expert recipient to data.expert.user.id', async () => {
    const expertRule: NotificationRule = {
      ...baseRule,
      recipient: 'expert',
    };

    const expertContext: RuleContext = {
      ...baseContext,
      data: {
        expert: { user: { id: 'expert-789' } },
      },
    };

    await dispatch(expertRule, expertContext);

    const deliveryPayload = mockAdd.mock.calls[0][1];
    expect(deliveryPayload.recipientId).toBe('expert-789');
  });

  it('resolves client recipient from payload.recipientId', async () => {
    const clientRule: NotificationRule = {
      ...baseRule,
      recipient: 'client',
    };

    const clientContext: RuleContext = {
      ...baseContext,
      payload: { correlationId: 'corr-123', recipientId: 'client-001' },
      data: {},
    };

    await dispatch(clientRule, clientContext);

    const deliveryPayload = mockAdd.mock.calls[0][1];
    expect(deliveryPayload.recipientId).toBe('client-001');
  });

  it('falls back to data.client.id when payload.recipientId is absent', async () => {
    const clientRule: NotificationRule = {
      ...baseRule,
      recipient: 'client',
    };

    const clientContext: RuleContext = {
      ...baseContext,
      payload: { correlationId: 'corr-123' },
      data: { client: { id: 'client-002' } },
    };

    await dispatch(clientRule, clientContext);

    const deliveryPayload = mockAdd.mock.calls[0][1];
    expect(deliveryPayload.recipientId).toBe('client-002');
  });

  // ── BAL-325 email_address: external non-user recipient from the payload ──
  describe('email_address recipient', () => {
    const referralRule: NotificationRule = {
      channel: 'email',
      recipient: 'email_address',
      template: 'expert-referral-invited',
      timing: 'immediate',
      priority: 'normal',
    };

    it('enqueues one email job with recipientId = correlationId (invitee email kept out of log/jobId) and recipientEmail = payload.recipientEmail', async () => {
      const context: RuleContext = {
        event: 'expert.referral_invited',
        payload: {
          correlationId: 'invite-1',
          recipientEmail: 'colleague@example.com',
          inviterName: 'Ada Lovelace',
        },
        data: {},
      };

      await dispatch(referralRule, context);

      expect(getQueue).toHaveBeenCalledWith('notification-email');
      expect(mockAdd).toHaveBeenCalledOnce();
      const deliveryPayload = mockAdd.mock.calls[0][1];
      // recipientId (log/dedup identity) is the invite correlationId — NOT the raw
      // invitee address — so no invitee PII leaks into the dispatcher log or jobId.
      expect(deliveryPayload.recipientId).toBe('invite-1');
      // Delivery still targets the literal invitee address.
      expect(deliveryPayload.recipientEmail).toBe('colleague@example.com');
      const opts = mockAdd.mock.calls[0][2];
      // jobId stays unique per invite (correlationId appears in both segments).
      expect(opts.jobId).toBe('expert-referral-invited--invite-1--invite-1');
    });

    it('skips dispatch when payload.correlationId is missing', async () => {
      const context: RuleContext = {
        event: 'expert.referral_invited',
        payload: { recipientEmail: 'colleague@example.com', inviterName: 'Ada' },
        data: {},
      };

      await dispatch(referralRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('warns and skips when payload.recipientEmail is missing', async () => {
      const context: RuleContext = {
        event: 'expert.referral_invited',
        payload: { correlationId: 'invite-1', inviterName: 'Ada Lovelace' },
        data: {},
      };

      await dispatch(referralRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('warns and skips when payload.recipientEmail is an empty string', async () => {
      const context: RuleContext = {
        event: 'expert.referral_invited',
        payload: { correlationId: 'invite-1', recipientEmail: '', inviterName: 'Ada' },
        data: {},
      };

      await dispatch(referralRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });
  });

  // ── BAL-289 fan-out: list-valued recipients enqueue one job per id ──
  describe('fan-out recipients', () => {
    const adminRule: NotificationRule = {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'project-proposal-accepted-admin',
      timing: 'immediate',
    };

    const notSelectedRule: NotificationRule = {
      channel: 'in-app',
      recipient: 'non_selected_experts',
      template: 'project-proposal-not-selected',
      timing: 'immediate',
    };

    it('enqueues one in-app job per id in data.adminUserIds with distinct jobIds', async () => {
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-1' },
        data: { adminUserIds: ['admin-1', 'admin-2', 'admin-3'] },
      };

      await dispatch(adminRule, context);

      expect(getQueue).toHaveBeenCalledWith('notification-in-app');
      expect(mockAdd).toHaveBeenCalledTimes(3);
      const recipientIds = mockAdd.mock.calls.map((call) => call[1].recipientId);
      expect(recipientIds).toEqual(['admin-1', 'admin-2', 'admin-3']);
      const jobIds = mockAdd.mock.calls.map((call) => call[2].jobId);
      expect(jobIds).toEqual([
        'project-proposal-accepted-admin--admin-1--prop-1',
        'project-proposal-accepted-admin--admin-2--prop-1',
        'project-proposal-accepted-admin--admin-3--prop-1',
      ]);
      expect(new Set(jobIds).size).toBe(3);
    });

    it('does not enqueue when data.adminUserIds is empty', async () => {
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-1' },
        data: { adminUserIds: [] },
      };

      await dispatch(adminRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('does not enqueue when data.adminUserIds is absent', async () => {
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-1' },
        data: {},
      };

      await dispatch(adminRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('enqueues one job per id in data.nonSelectedExpertUserIds with distinct jobIds', async () => {
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-9' },
        data: { nonSelectedExpertUserIds: ['expert-a', 'expert-b'] },
      };

      await dispatch(notSelectedRule, context);

      expect(mockAdd).toHaveBeenCalledTimes(2);
      const recipientIds = mockAdd.mock.calls.map((call) => call[1].recipientId);
      expect(recipientIds).toEqual(['expert-a', 'expert-b']);
      const jobIds = mockAdd.mock.calls.map((call) => call[2].jobId);
      expect(jobIds).toEqual([
        'project-proposal-not-selected--expert-a--prop-9',
        'project-proposal-not-selected--expert-b--prop-9',
      ]);
      expect(new Set(jobIds).size).toBe(2);
    });

    it('does not enqueue when data.nonSelectedExpertUserIds is empty', async () => {
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-9' },
        data: { nonSelectedExpertUserIds: [] },
      };

      await dispatch(notSelectedRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('fans the non_selected_experts EMAIL rule out to one email job per id, recipientId set + recipientEmail undefined (worker resolves the address)', async () => {
      const notSelectedEmailRule: NotificationRule = {
        channel: 'email',
        recipient: 'non_selected_experts',
        template: 'project-proposal-not-selected',
        timing: 'immediate',
        priority: 'normal',
      };
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-9' },
        data: { nonSelectedExpertUserIds: ['expert-a', 'expert-b', 'expert-c'] },
      };

      await dispatch(notSelectedEmailRule, context);

      // One email job per id, all on the email queue.
      expect(getQueue).toHaveBeenCalledWith('notification-email');
      expect(mockAdd).toHaveBeenCalledTimes(3);

      const recipientIds = mockAdd.mock.calls.map((call) => call[1].recipientId);
      expect(recipientIds).toEqual(['expert-a', 'expert-b', 'expert-c']);

      // The fan-out path never sets recipientEmail — the email worker resolves
      // the address from recipientId (usersRepository.findById).
      for (const call of mockAdd.mock.calls) {
        expect(call[1].recipientEmail).toBeUndefined();
      }

      // Distinct, deterministic dedup job ids.
      const jobIds = mockAdd.mock.calls.map((call) => call[2].jobId);
      expect(jobIds).toEqual([
        'project-proposal-not-selected--expert-a--prop-9',
        'project-proposal-not-selected--expert-b--prop-9',
        'project-proposal-not-selected--expert-c--prop-9',
      ]);
      expect(new Set(jobIds).size).toBe(3);
    });

    it('filters non-string entries out of a fan-out list', async () => {
      const context: RuleContext = {
        event: 'project.proposal_accepted',
        payload: { correlationId: 'prop-1' },
        data: { adminUserIds: ['admin-1', undefined, null, 42, 'admin-2'] },
      };

      await dispatch(adminRule, context);

      expect(mockAdd).toHaveBeenCalledTimes(2);
      const recipientIds = mockAdd.mock.calls.map((call) => call[1].recipientId);
      expect(recipientIds).toEqual(['admin-1', 'admin-2']);
    });
  });
});
