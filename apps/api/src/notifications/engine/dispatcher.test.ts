import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queue.js')>()),
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

  // ── BAL-324: billing_creator resolves to a single payload id (NOT a fan-out) ──
  it('resolves billing_creator recipient from payload.creatorUserId', async () => {
    const creatorRule: NotificationRule = {
      ...baseRule,
      recipient: 'billing_creator',
      template: 'project-billing-reminder-creator',
    };
    const context: RuleContext = {
      event: 'project.billing_reminder',
      payload: { correlationId: 'corr-bill', recipientId: 'owner-1', creatorUserId: 'creator-1' },
      data: {},
    };

    await dispatch(creatorRule, context);

    const deliveryPayload = mockAdd.mock.calls[0][1];
    expect(deliveryPayload.recipientId).toBe('creator-1');
  });

  it('skips billing_creator dispatch when payload.creatorUserId is absent', async () => {
    const creatorRule: NotificationRule = {
      ...baseRule,
      recipient: 'billing_creator',
      template: 'project-billing-reminder-creator',
    };
    const context: RuleContext = {
      event: 'project.billing_reminder',
      payload: { correlationId: 'corr-bill', recipientId: 'owner-1' },
      data: {},
    };

    await dispatch(creatorRule, context);

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('mints distinct jobIds for owner vs creator on the same billing reminder', async () => {
    const ownerRule: NotificationRule = {
      ...baseRule,
      recipient: 'client',
      template: 'project-billing-reminder-owner',
    };
    const creatorRule: NotificationRule = {
      ...baseRule,
      recipient: 'billing_creator',
      template: 'project-billing-reminder-creator',
    };
    const context: RuleContext = {
      event: 'project.billing_reminder',
      payload: { correlationId: 'corr-bill', recipientId: 'owner-1', creatorUserId: 'creator-1' },
      data: {},
    };

    await dispatch(ownerRule, context);
    await dispatch(creatorRule, context);

    const jobIds = mockAdd.mock.calls.map((call) => call[2].jobId);
    expect(jobIds).toEqual([
      'project-billing-reminder-owner--owner-1--corr-bill',
      'project-billing-reminder-creator--creator-1--corr-bill',
    ]);
    expect(new Set(jobIds).size).toBe(2);
  });

  // ── BAL-348: owner resolves to a single payload id (NOT a fan-out) ──
  describe('owner recipient (agency.provisioned)', () => {
    const ownerRule: NotificationRule = {
      ...baseRule,
      recipient: 'owner',
      template: 'agency-provisioned',
    };
    const context: RuleContext = {
      event: 'agency.provisioned',
      payload: { correlationId: 'agency-1', agencyId: 'agency-1', ownerUserId: 'owner-1' },
      data: { agency: { id: 'agency-1', name: 'CloudPeak' } },
    };

    it('resolves the owner recipient from payload.ownerUserId', async () => {
      await dispatch(ownerRule, context);
      const deliveryPayload = mockAdd.mock.calls[0][1];
      expect(deliveryPayload.recipientId).toBe('owner-1');
    });

    it('mints the idempotency jobId {template}--{ownerUserId}--{agencyId}', async () => {
      await dispatch(ownerRule, context);
      const opts = mockAdd.mock.calls[0][2];
      // correlationId === agencyId, so the jobId is stable per agency → a re-dispatch
      // (BullMQ dedup) never double-delivers.
      expect(opts.jobId).toBe('agency-provisioned--owner-1--agency-1');
    });

    it('enqueues exactly one job per dispatch (single recipient, not a fan-out)', async () => {
      await dispatch(ownerRule, context);
      expect(mockAdd).toHaveBeenCalledOnce();
    });

    it('skips dispatch when payload.ownerUserId is absent', async () => {
      await dispatch(ownerRule, {
        event: 'agency.provisioned',
        payload: { correlationId: 'agency-1', agencyId: 'agency-1' },
        data: {},
      });
      expect(mockAdd).not.toHaveBeenCalled();
    });
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

    // ── BAL-345: party_admins fan-out ──
    const partyAdminsRule: NotificationRule = {
      channel: 'in-app',
      recipient: 'party_admins',
      template: 'party-join-request-created',
      timing: 'immediate',
    };

    it('enqueues one job per id in data.partyAdminUserIds (BAL-345 party_admins)', async () => {
      const context: RuleContext = {
        event: 'party.join_request_created',
        payload: { correlationId: 'req-1' },
        data: { partyAdminUserIds: ['owner-1', 'admin-2'] },
      };

      await dispatch(partyAdminsRule, context);

      expect(getQueue).toHaveBeenCalledWith('notification-in-app');
      expect(mockAdd).toHaveBeenCalledTimes(2);
      const recipientIds = mockAdd.mock.calls.map((call) => call[1].recipientId);
      expect(recipientIds).toEqual(['owner-1', 'admin-2']);
      const jobIds = mockAdd.mock.calls.map((call) => call[2].jobId);
      expect(jobIds).toEqual([
        'party-join-request-created--owner-1--req-1',
        'party-join-request-created--admin-2--req-1',
      ]);
    });

    it('does not enqueue when data.partyAdminUserIds is absent (BAL-345)', async () => {
      const context: RuleContext = {
        event: 'party.join_request_created',
        payload: { correlationId: 'req-1' },
        data: {},
      };

      await dispatch(partyAdminsRule, context);

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

    // ── BAL-540: request_track_experts fan-out, resolved from the PAYLOAD ──
    it('fans request_track_experts out over payload.recipientUserIds (publisher-resolved, not hydrated)', async () => {
      const requestTrackExpertsRule: NotificationRule = {
        channel: 'email',
        recipient: 'request_track_experts',
        template: 'project-request-closed-expert',
        timing: 'immediate',
        priority: 'normal',
      };
      const context: RuleContext = {
        event: 'project.request_closed',
        payload: {
          correlationId: 'close-1',
          recipientUserIds: ['expert-x', 'expert-y'],
        },
        data: {},
      };

      await dispatch(requestTrackExpertsRule, context);

      expect(getQueue).toHaveBeenCalledWith('notification-email');
      expect(mockAdd).toHaveBeenCalledTimes(2);
      const recipientIds = mockAdd.mock.calls.map((call) => call[1].recipientId);
      expect(recipientIds).toEqual(['expert-x', 'expert-y']);
      const jobIds = mockAdd.mock.calls.map((call) => call[2].jobId);
      expect(jobIds).toEqual([
        'project-request-closed-expert--expert-x--close-1',
        'project-request-closed-expert--expert-y--close-1',
      ]);
    });

    it('does not enqueue when payload.recipientUserIds is empty (a zero-track close)', async () => {
      const requestTrackExpertsRule: NotificationRule = {
        channel: 'email',
        recipient: 'request_track_experts',
        template: 'project-request-closed-expert',
        timing: 'immediate',
        priority: 'normal',
      };
      const context: RuleContext = {
        event: 'project.request_closed',
        payload: { correlationId: 'close-1', recipientUserIds: [] },
        data: {},
      };

      await dispatch(requestTrackExpertsRule, context);

      expect(mockAdd).not.toHaveBeenCalled();
    });
  });
});

/**
 * BAL-531 — the emitted jobId STRING is the load-bearing assertion here, not `add` resolving.
 * The ticket's own acceptance criterion ("assert `channelQueue.add` succeeds") is vacuous as
 * written: `mockAdd` is a mocked function that cannot enforce BullMQ's real colon rule, so it
 * resolves identically whether the jobId is well-formed or not. Every fixture below pins the
 * exact escaped string via `buildJobId` (kept REAL above via `importOriginal`, never mocked
 * away) so a regression back to `` `${rule.template}--${recipientId}--${correlationId}` `` is
 * caught on the string, not the mock call succeeding.
 *
 * That the entire suite ABOVE this block uses colon-free templates, recipient ids and
 * correlationIds (`'welcome--user-456--corr-123'`, `'project-request-closed-expert--expert-x--close-1'`,
 * …) is precisely why this bug survived BAL-289 → BAL-531: every existing fixture happens to
 * avoid the shape that throws.
 */
describe('dispatch — BAL-531 colon-bearing correlationIds no longer throw at queue.add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const rule: NotificationRule = {
    channel: 'email',
    recipient: 'self',
    template: 'credit-session-low-balance',
    timing: 'immediate',
  };

  function contextWith(correlationId: string): RuleContext {
    return {
      event: 'credit.session.low_balance',
      payload: { correlationId, userId: 'user-456' },
      data: {},
    } as RuleContext;
  }

  it('one-colon correlationId — zero colons in the emitted jobId, exact string pinned', async () => {
    await dispatch(rule, contextWith('sess-1:low_balance'));

    const opts = mockAdd.mock.calls[0][2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toBe('credit-session-low-balance--user-456--sess-1_clow__balance');
  });

  it('three-colon correlationId — zero colons in the emitted jobId, exact string pinned', async () => {
    await dispatch(rule, contextWith('w1:dormancy_reminder:band-a:2026-09-07'));

    const opts = mockAdd.mock.calls[0][2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toBe(
      'credit-session-low-balance--user-456--w1_cdormancy__reminder_cband-a_c2026-09-07'
    );
  });

  it('two-colon correlationId — documents the deliberate rewrite of an id that delivers today', async () => {
    // `auto_topup:{wallet}:{entry}` is a TWO-colon shape, which the raw upstream predicate
    // (`jobId.includes(':') && jobId.split(':').length !== 3`) already accepted — this id
    // delivered notifications BEFORE this ticket. `buildJobId` still rewrites it (D1: uniform
    // escaping), so the ONLY regression this pins is that it stays colon-free and distinct.
    await dispatch(rule, contextWith('auto_topup:wallet-a:entry-1'));

    const opts = mockAdd.mock.calls[0][2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toBe('credit-session-low-balance--user-456--auto__topup_cwallet-a_centry-1');
  });
});
