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
});
