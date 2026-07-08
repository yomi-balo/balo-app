import { describe, it, expect } from 'vitest';
import { notificationRules } from './rules.js';

describe('notificationRules', () => {
  it('has rules for user.welcome event', () => {
    const rules = notificationRules['user.welcome'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
  });

  it('user.welcome rule has correct config', () => {
    const [rule] = notificationRules['user.welcome']!;
    expect(rule.channel).toBe('email');
    expect(rule.recipient).toBe('self');
    expect(rule.template).toBe('welcome');
    expect(rule.timing).toBe('immediate');
    expect(rule.priority).toBe('critical');
  });

  it('has rules for expert.application_submitted event', () => {
    const rules = notificationRules['expert.application_submitted'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
  });

  it('expert.application_submitted rule has correct config', () => {
    const [rule] = notificationRules['expert.application_submitted']!;
    expect(rule.channel).toBe('email');
    expect(rule.recipient).toBe('self');
    expect(rule.template).toBe('application-submitted');
    expect(rule.timing).toBe('immediate');
    expect(rule.priority).toBe('critical');
  });

  it('has rules for project.request_submitted event', () => {
    const rules = notificationRules['project.request_submitted'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
  });

  it('project.request_submitted rule has correct config', () => {
    const [rule] = notificationRules['project.request_submitted']!;
    expect(rule.channel).toBe('email');
    expect(rule.recipient).toBe('expert');
    expect(rule.template).toBe('project-request-submitted');
    expect(rule.timing).toBe('immediate');
    expect(rule.priority).toBe('normal');
  });

  it('booking.confirmed has in-app rule for expert', () => {
    const rules = notificationRules['booking.confirmed'];
    expect(rules).toBeDefined();
    const inAppRule = rules!.find((r) => r.channel === 'in-app');
    expect(inAppRule).toBeDefined();
    expect(inAppRule!.recipient).toBe('expert');
    expect(inAppRule!.template).toBe('booking-confirmed');
    expect(inAppRule!.timing).toBe('immediate');
  });

  it('booking.confirmed SMS rule condition returns false when phoneVerifiedAt is not set', () => {
    const rules = notificationRules['booking.confirmed'];
    const smsRule = rules!.find((r) => r.channel === 'sms');
    expect(smsRule!.condition).toBeDefined();
    const result = smsRule!.condition!({
      event: 'booking.confirmed',
      payload: {},
      data: { user: { phoneVerifiedAt: null } },
    });
    expect(result).toBe(false);
  });

  it('booking.confirmed SMS rule condition returns true when phoneVerifiedAt is set', () => {
    const rules = notificationRules['booking.confirmed'];
    const smsRule = rules!.find((r) => r.channel === 'sms');
    const result = smsRule!.condition!({
      event: 'booking.confirmed',
      payload: {},
      data: { user: { phoneVerifiedAt: new Date().toISOString() } },
    });
    expect(result).toBe(true);
  });

  it('project.exploratory_requested has client email + in-app rules', () => {
    const rules = notificationRules['project.exploratory_requested'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(2);
    const email = rules!.find((r) => r.channel === 'email');
    expect(email).toMatchObject({
      recipient: 'client',
      template: 'project-exploratory-requested',
      timing: 'immediate',
      priority: 'normal',
    });
    const inApp = rules!.find((r) => r.channel === 'in-app');
    expect(inApp).toMatchObject({
      recipient: 'client',
      template: 'project-exploratory-requested',
      timing: 'immediate',
    });
  });

  it('project.expert_invited has expert email + in-app rules', () => {
    const rules = notificationRules['project.expert_invited'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(2);
    const email = rules!.find((r) => r.channel === 'email');
    expect(email).toMatchObject({
      recipient: 'expert',
      template: 'project-expert-invited',
      timing: 'immediate',
      priority: 'normal',
    });
    const inApp = rules!.find((r) => r.channel === 'in-app');
    expect(inApp).toMatchObject({
      recipient: 'expert',
      template: 'project-expert-invited',
      timing: 'immediate',
    });
  });

  it('project.eoi_submitted has client email + in-app rules', () => {
    const rules = notificationRules['project.eoi_submitted'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(2);
    const email = rules!.find((r) => r.channel === 'email');
    expect(email).toMatchObject({
      recipient: 'client',
      template: 'project-eoi-submitted',
      timing: 'immediate',
      priority: 'normal',
    });
    const inApp = rules!.find((r) => r.channel === 'in-app');
    expect(inApp).toMatchObject({
      recipient: 'client',
      template: 'project-eoi-submitted',
      timing: 'immediate',
    });
  });

  it('project.proposal_requested has expert email + in-app rules (BAL-272 commit moment)', () => {
    const rules = notificationRules['project.proposal_requested'];
    expect(rules).toBeDefined();
    // BAL-315 adds a 3rd rule (the conditioned client heads-up) — the two expert
    // rules stay byte-for-byte identical.
    expect(rules).toHaveLength(3);
    const email = rules!.find((r) => r.channel === 'email');
    expect(email).toMatchObject({
      recipient: 'expert',
      template: 'project-proposal-requested',
      timing: 'immediate',
      priority: 'normal',
    });
    const expertInApp = rules!.find((r) => r.channel === 'in-app' && r.recipient === 'expert');
    expect(expertInApp).toMatchObject({
      recipient: 'expert',
      template: 'project-proposal-requested',
      timing: 'immediate',
    });
    // The unconditioned expert rules must never carry a `condition` (they fire for
    // every initiator).
    expect(email!.condition).toBeUndefined();
    expect(expertInApp!.condition).toBeUndefined();
  });

  it('project.proposal_requested gates the client heads-up on initiatedBy === admin (BAL-315)', () => {
    const rules = notificationRules['project.proposal_requested']!;
    const clientRule = rules.find((r) => r.recipient === 'client');
    expect(clientRule).toMatchObject({
      channel: 'in-app',
      recipient: 'client',
      template: 'project-proposal-requested-client',
      timing: 'immediate',
    });
    expect(clientRule!.condition).toBeDefined();

    // Fires ONLY for the admin-on-behalf path; the client's OWN request is skipped.
    const adminCtx = {
      event: 'project.proposal_requested',
      payload: { initiatedBy: 'admin' },
      data: {},
    };
    const clientCtx = {
      event: 'project.proposal_requested',
      payload: { initiatedBy: 'client' },
      data: {},
    };
    expect(clientRule!.condition!(adminCtx)).toBe(true);
    expect(clientRule!.condition!(clientCtx)).toBe(false);
  });

  it('project.proposal_accepted fans out to expert, non-selected experts, and admins (BAL-289)', () => {
    const rules = notificationRules['project.proposal_accepted'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(5);

    // Winning expert: in-app + email.
    const expertRules = rules!.filter((r) => r.recipient === 'expert');
    expect(expertRules).toHaveLength(2);
    for (const rule of expertRules) {
      expect(rule.template).toBe('project-proposal-accepted');
      expect(rule.timing).toBe('immediate');
    }
    expect(expertRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
      'email',
      'in-app',
    ]);

    // Non-selected experts: in-app + email.
    const notSelectedRules = rules!.filter((r) => r.recipient === 'non_selected_experts');
    expect(notSelectedRules).toHaveLength(2);
    for (const rule of notSelectedRules) {
      expect(rule.template).toBe('project-proposal-not-selected');
    }
    expect(notSelectedRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
      'email',
      'in-app',
    ]);

    // Admins: in-app only (net-new in-app fan-out).
    const adminRules = rules!.filter((r) => r.recipient === 'admin_users');
    expect(adminRules).toHaveLength(1);
    expect(adminRules[0]).toMatchObject({
      channel: 'in-app',
      template: 'project-proposal-accepted-admin',
      timing: 'immediate',
    });
  });

  it('billing.details_confirmed notifies admins in-app only (BAL-323)', () => {
    const rules = notificationRules['billing.details_confirmed'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0]).toMatchObject({
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'billing-details-confirmed-admin',
      timing: 'immediate',
    });
    // In-app ONLY — never email/SMS (not time-sensitive).
    expect(rules!.some((r) => r.channel !== 'in-app')).toBe(false);
  });

  it('has rules for message.received event', () => {
    const rules = notificationRules['message.received'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0].channel).toBe('in-app');
    expect(rules![0].recipient).toBe('client');
    expect(rules![0].template).toBe('new-message');
  });

  describe.each([
    ['project.message_posted', 'project-message-posted'],
    ['project.file_shared', 'project-file-shared'],
  ] as const)('%s rules', (event, template) => {
    it('is in-app only — one conditioned rule per recipient role', () => {
      const rules = notificationRules[event];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.channel).toBe('in-app');
        expect(rule.template).toBe(template);
        expect(rule.timing).toBe('immediate');
        expect(rule.condition).toBeDefined();
      }
      expect(rules!.map((r) => r.recipient).sort((a, b) => a.localeCompare(b))).toEqual([
        'client',
        'expert',
      ]);
    });

    it('routes by payload.recipientRole — exactly one rule fires per event', () => {
      const rules = notificationRules[event]!;
      const clientRule = rules.find((r) => r.recipient === 'client')!;
      const expertRule = rules.find((r) => r.recipient === 'expert')!;

      const toClient = { event, payload: { recipientRole: 'client' }, data: {} };
      expect(clientRule.condition!(toClient)).toBe(true);
      expect(expertRule.condition!(toClient)).toBe(false);

      const toExpert = { event, payload: { recipientRole: 'expert' }, data: {} };
      expect(clientRule.condition!(toExpert)).toBe(false);
      expect(expertRule.condition!(toExpert)).toBe(true);
    });
  });

  describe('project.billing_reminder (BAL-324)', () => {
    it('gives the owner email + in-app via recipient:client, no condition', () => {
      const rules = notificationRules['project.billing_reminder'];
      expect(rules).toBeDefined();
      // owner (email + in-app) + creator (email + in-app) = 4 rules.
      expect(rules).toHaveLength(4);

      const ownerRules = rules!.filter((r) => r.recipient === 'client');
      expect(ownerRules).toHaveLength(2);
      for (const rule of ownerRules) {
        expect(rule.template).toBe('project-billing-reminder-owner');
        expect(rule.timing).toBe('immediate');
        // Owner is always notified — no gating condition.
        expect(rule.condition).toBeUndefined();
      }
      expect(ownerRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
    });

    it('gives the creator email + in-app via recipient:billing_creator, gated on creatorUserId', () => {
      const rules = notificationRules['project.billing_reminder']!;
      const creatorRules = rules.filter((r) => r.recipient === 'billing_creator');
      expect(creatorRules).toHaveLength(2);
      for (const rule of creatorRules) {
        expect(rule.template).toBe('project-billing-reminder-creator');
        expect(rule.timing).toBe('immediate');
        expect(rule.condition).toBeDefined();
      }
      expect(creatorRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
    });

    it('creator condition fires only when creatorUserId is present AND != recipientId', () => {
      const rules = notificationRules['project.billing_reminder']!;
      const [creatorRule] = rules.filter((r) => r.recipient === 'billing_creator');
      const condition = creatorRule!.condition!;

      // Present + distinct from the owner → fires.
      expect(
        condition({
          event: 'project.billing_reminder',
          payload: { creatorUserId: 'creator-1', recipientId: 'owner-1' },
          data: {},
        })
      ).toBe(true);

      // Absent → skipped (owner-only publish).
      expect(
        condition({
          event: 'project.billing_reminder',
          payload: { recipientId: 'owner-1' },
          data: {},
        })
      ).toBe(false);

      // Equal to the owner → never self-notify.
      expect(
        condition({
          event: 'project.billing_reminder',
          payload: { creatorUserId: 'owner-1', recipientId: 'owner-1' },
          data: {},
        })
      ).toBe(false);
    });
  });

  describe('BAL-345 domain auto-join', () => {
    it('member_joined_via_domain notifies party_admins in-app ONLY (low-signal FYI)', () => {
      const rules = notificationRules['party.member_joined_via_domain'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(1);
      expect(rules![0]).toMatchObject({
        channel: 'in-app',
        recipient: 'party_admins',
        template: 'party-member-joined-via-domain',
        timing: 'immediate',
      });
    });

    it('join_request_created notifies party_admins via email + in-app', () => {
      const rules = notificationRules['party.join_request_created'];
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.recipient).toBe('party_admins');
        expect(rule.template).toBe('party-join-request-created');
      }
      expect(rules!.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
    });

    it.each([
      ['party.join_request_approved', 'party-join-request-approved'],
      ['party.join_request_declined', 'party-join-request-declined'],
    ] as const)('%s notifies the requester (self) via email + in-app', (event, template) => {
      const rules = notificationRules[event];
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.recipient).toBe('self');
        expect(rule.template).toBe(template);
      }
      expect(rules!.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
    });
  });

  describe('BAL-332 milestone delivery events', () => {
    it('milestone_completed: client owner email + in-app AND admins in-app', () => {
      const rules = notificationRules['engagement.milestone_completed'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(3);

      const clientRules = rules!.filter((r) => r.recipient === 'client');
      expect(clientRules).toHaveLength(2);
      for (const rule of clientRules) {
        expect(rule.template).toBe('engagement-milestone-completed-client');
      }
      expect(clientRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);

      const adminRules = rules!.filter((r) => r.recipient === 'admin_users');
      expect(adminRules).toHaveLength(1);
      expect(adminRules[0]).toMatchObject({
        channel: 'in-app',
        template: 'engagement-milestone-completed-admin',
        timing: 'immediate',
      });
    });

    it('milestone_reverted: client + admins, in-app ONLY, one shared template', () => {
      const rules = notificationRules['engagement.milestone_reverted'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.channel).toBe('in-app');
        expect(rule.template).toBe('engagement-milestone-reverted');
        expect(rule.timing).toBe('immediate');
      }
      expect(rules!.map((r) => r.recipient).sort((a, b) => a.localeCompare(b))).toEqual([
        'admin_users',
        'client',
      ]);
      // Never email/SMS — reverts are never silent but aren't email-worthy.
      expect(rules!.some((r) => r.channel !== 'in-app')).toBe(false);
    });

    it('milestone_started publishes nothing (no rule set)', () => {
      expect(notificationRules['engagement.milestone_started']).toBeUndefined();
    });
  });

  describe('BAL-333 delivery-plan scope changed', () => {
    it('scope_changed: client owner email + in-app AND admins in-app', () => {
      const rules = notificationRules['engagement.scope_changed'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(3);

      const clientRules = rules!.filter((r) => r.recipient === 'client');
      expect(clientRules).toHaveLength(2);
      for (const rule of clientRules) {
        expect(rule.template).toBe('engagement-scope-changed-client');
        expect(rule.timing).toBe('immediate');
      }
      expect(clientRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);

      const adminRules = rules!.filter((r) => r.recipient === 'admin_users');
      expect(adminRules).toHaveLength(1);
      expect(adminRules[0]).toMatchObject({
        channel: 'in-app',
        template: 'engagement-scope-changed-admin',
        timing: 'immediate',
      });

      // No SMS — client is told by email + in-app; admins get an in-app ops signal.
      expect(rules!.some((r) => r.channel === 'sms')).toBe(false);
    });
  });

  it('all rules use timing immediate', () => {
    for (const [, rules] of Object.entries(notificationRules)) {
      for (const rule of rules) {
        expect(rule.timing).toBe('immediate');
      }
    }
  });

  it('all rules use a valid notification channel', () => {
    const validChannels = ['email', 'sms', 'in-app'];
    for (const [, rules] of Object.entries(notificationRules)) {
      for (const rule of rules) {
        expect(validChannels).toContain(rule.channel);
      }
    }
  });
});
