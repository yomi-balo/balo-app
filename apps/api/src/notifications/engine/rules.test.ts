import { describe, it, expect } from 'vitest';
import { notificationRules, type NotificationRule } from './rules.js';

/**
 * N13 — SHARED BY `booking.confirmed` AND `booking.rescheduled` (both new-code from BAL-409),
 * which were previously two near-verbatim ~13-line blocks with only the template names
 * differing — exactly the shape SonarCloud's >3% new-code duplication gate flags. Asserts the
 * "client + expert each get email + in-app, 4 rules, no SMS, no admin fan-out" shape for either
 * event.
 */
function expectEmailAndInAppPair(
  event: 'booking.confirmed' | 'booking.rescheduled',
  clientTemplate: string,
  expertTemplate: string
): void {
  const rules = notificationRules[event];
  expect(rules).toBeDefined();
  expect(rules).toHaveLength(4);
  for (const rule of rules!) {
    expect(rule.timing).toBe('immediate');
  }
  const clientRules = rules!.filter((r) => r.recipient === 'client');
  const expertRules = rules!.filter((r) => r.recipient === 'expert');
  expect(clientRules).toHaveLength(2);
  expect(expertRules).toHaveLength(2);
  expect(clientRules.every((r) => r.template === clientTemplate)).toBe(true);
  expect(expertRules.every((r) => r.template === expertTemplate)).toBe(true);
  expect(clientRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
    'email',
    'in-app',
  ]);
  expect(expertRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
    'email',
    'in-app',
  ]);
  expect(rules!.some((r) => r.channel === 'sms')).toBe(false);
  expect(rules!.some((r) => r.recipient === 'admin_users')).toBe(false);
}

/** N13 — the gating half: client rules require `recipientId`, expert rules are unconditioned. */
function expectClientRulesGatedOnRecipientId(
  event: 'booking.confirmed' | 'booking.rescheduled'
): void {
  const rules = notificationRules[event]!;
  const clientRules = rules.filter((r) => r.recipient === 'client');
  const expertRules = rules.filter((r) => r.recipient === 'expert');
  for (const rule of clientRules) {
    expect(rule.condition).toBeDefined();
    const base = { event, data: {} };
    expect(rule.condition!({ ...base, payload: { recipientId: 'user-1' } })).toBe(true);
    expect(rule.condition!({ ...base, payload: {} })).toBe(false);
  }
  expect(expertRules.every((r) => r.condition === undefined)).toBe(true);
}

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

  it('booking.confirmed: client + expert each get email + in-app — 4 rules, no SMS, no admin fan-out', () => {
    expectEmailAndInAppPair(
      'booking.confirmed',
      'booking-confirmed-client',
      'booking-confirmed-expert'
    );
  });

  it('booking.confirmed: the client rules are gated on recipientId; the expert rules are unconditioned', () => {
    expectClientRulesGatedOnRecipientId('booking.confirmed');
  });

  it('booking.rescheduled: client + expert each get email + in-app — 4 rules, no SMS, no admin fan-out', () => {
    expectEmailAndInAppPair(
      'booking.rescheduled',
      'booking-rescheduled-client',
      'booking-rescheduled-expert'
    );
  });

  it('booking.rescheduled: the client rules are gated on recipientId; the expert rules are unconditioned', () => {
    expectClientRulesGatedOnRecipientId('booking.rescheduled');
  });

  it('meeting.guest_rescheduled: EMAIL ONLY, to the external `email_address`', () => {
    const rules = notificationRules['meeting.guest_rescheduled'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0]).toMatchObject({
      channel: 'email',
      recipient: 'email_address',
      template: 'meeting-guest-rescheduled',
      timing: 'immediate',
      priority: 'normal',
    });
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

  it('calendar.subscription_lapse notifies admins in-app only (BAL-468)', () => {
    const rules = notificationRules['calendar.subscription_lapse'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0]).toMatchObject({
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'calendar-subscription-lapse-admin',
      timing: 'immediate',
    });
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
    ['conversation.message_posted', 'conversation-message-posted'],
    ['conversation.file_shared', 'conversation-file-shared'],
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

    /**
     * ⚠⚠ THE FOLLOW-UP HOOK DEPENDS ON THIS. `processNotificationEvent` RETURNS EARLY on an
     * event with no rules, and the hook that schedules the 10-minute unread digest runs AFTER
     * that lookup — so emptying either array would silently disable the unread email for that
     * half of the exchange, with nothing else failing.
     */
    it('keeps at least one rule, or the unread-digest follow-up never runs', () => {
      expect(notificationRules[event]?.length ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  /** BAL-424 — the debounced unread digest. EMAIL only; the in-app notice already fired. */
  describe('conversation.unread_digest_due rules', () => {
    it('is email-only, one conditioned rule per recipient role', () => {
      const rules = notificationRules['conversation.unread_digest_due'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.channel).toBe('email');
        expect(rule.template).toBe('conversation-unread-digest');
        expect(rule.timing).toBe('immediate');
        expect(rule.condition).toBeDefined();
        // Both arms resolve the SAME stored `recipientUserId` — it was already resolved to a
        // user id at SCHEDULE time, because the fire-time recheck reads the watermark by user.
        expect(rule.recipient).toBe('self');
      }
    });

    it('routes by payload.recipientRole — exactly one rule fires per publish', () => {
      const rules = notificationRules['conversation.unread_digest_due']!;
      const [clientRule, expertRule] = rules;
      const toClient = {
        event: 'conversation.unread_digest_due',
        payload: { recipientRole: 'client' },
        data: {},
      };
      expect(clientRule!.condition!(toClient)).toBe(true);
      expect(expertRule!.condition!(toClient)).toBe(false);

      const toExpert = {
        event: 'conversation.unread_digest_due',
        payload: { recipientRole: 'expert' },
        data: {},
      };
      expect(clientRule!.condition!(toExpert)).toBe(false);
      expect(expertRule!.condition!(toExpert)).toBe(true);
    });

    it('never sends the digest in-app — the immediate events already did', () => {
      const rules = notificationRules['conversation.unread_digest_due']!;
      expect(rules.some((r) => r.channel === 'in-app')).toBe(false);
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

  describe('BAL-348 agency.provisioned', () => {
    it('notifies the owner via email + in-app, template agency-provisioned', () => {
      const rules = notificationRules['agency.provisioned'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.recipient).toBe('owner');
        expect(rule.template).toBe('agency-provisioned');
        expect(rule.timing).toBe('immediate');
        // Single recipient — no gating condition.
        expect(rule.condition).toBeUndefined();
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

  describe('BAL-334 engagement lifecycle events', () => {
    it('completion_requested: client owner email + in-app AND admins in-app', () => {
      const rules = notificationRules['engagement.completion_requested'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(3);

      const clientRules = rules!.filter((r) => r.recipient === 'client');
      expect(clientRules).toHaveLength(2);
      for (const rule of clientRules) {
        expect(rule.template).toBe('engagement-completion-requested-client');
      }
      expect(clientRules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);

      const adminRules = rules!.filter((r) => r.recipient === 'admin_users');
      expect(adminRules).toHaveLength(1);
      expect(adminRules[0]).toMatchObject({
        channel: 'in-app',
        template: 'engagement-completion-requested-admin',
        timing: 'immediate',
      });
    });

    it('completion_withdrawn: client + admins, in-app ONLY, one shared template', () => {
      const rules = notificationRules['engagement.completion_withdrawn'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(2);
      for (const rule of rules!) {
        expect(rule.channel).toBe('in-app');
        expect(rule.template).toBe('engagement-completion-withdrawn');
        expect(rule.timing).toBe('immediate');
      }
      expect(rules!.map((r) => r.recipient).sort((a, b) => a.localeCompare(b))).toEqual([
        'admin_users',
        'client',
      ]);
      expect(rules!.some((r) => r.channel !== 'in-app')).toBe(false);
    });

    it('cancelled: client + expert email + in-app, one shared template, no admin recipient', () => {
      const rules = notificationRules['engagement.cancelled'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(4);
      for (const rule of rules!) {
        expect(rule.template).toBe('engagement-cancelled');
        expect(rule.timing).toBe('immediate');
      }
      expect(rules!.map((r) => r.recipient).sort((a, b) => a.localeCompare(b))).toEqual([
        'client',
        'client',
        'expert',
        'expert',
      ]);
      // Both parties get email + in-app; admins are never a recipient (they are the actor).
      expect(rules!.some((r) => r.recipient === 'admin_users')).toBe(false);
      expect(rules!.filter((r) => r.channel === 'email')).toHaveLength(2);
      expect(rules!.filter((r) => r.channel === 'in-app')).toHaveLength(2);
    });
  });

  describe('BAL-374 onboarding.reminder', () => {
    it('is a single email/self rule with the onboarding-reminder template (no in-app)', () => {
      const rules = notificationRules['onboarding.reminder'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(1);
      expect(rules![0]).toMatchObject({
        channel: 'email',
        recipient: 'self',
        template: 'onboarding-reminder',
        timing: 'immediate',
        priority: 'normal',
      });
      // Email ONLY — the un-onboarded user has no in-app surface (no bell).
      expect(rules!.some((r) => r.channel !== 'email')).toBe(false);
      // Single unconditioned rule — fires for all three cadence steps.
      expect(rules![0].condition).toBeUndefined();
    });
  });

  describe('BAL-386 proposal.shared', () => {
    it('resolves to exactly one email / email_address / proposal-shared rule (no expert notification)', () => {
      const rules = notificationRules['proposal.shared'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(1);
      expect(rules![0]).toMatchObject({
        channel: 'email',
        recipient: 'email_address',
        template: 'proposal-shared',
        timing: 'immediate',
        priority: 'normal',
      });
      // Email ONLY to the external colleague — never in-app/SMS, never the expert.
      expect(rules!.some((r) => r.channel !== 'email')).toBe(false);
      expect(rules![0].condition).toBeUndefined();
    });
  });

  describe('BAL-391 action_item.assigned', () => {
    it('gives each side email + in-app, one shared template, no admin fan-out', () => {
      const rules = notificationRules['action_item.assigned'];
      expect(rules).toBeDefined();
      // client (email + in-app) + expert (email + in-app) = 4 conditioned rules.
      expect(rules).toHaveLength(4);
      for (const rule of rules!) {
        expect(rule.template).toBe('action-item-assigned');
        expect(rule.timing).toBe('immediate');
        expect(rule.condition).toBeDefined();
      }
      expect(rules!.map((r) => r.recipient).sort((a, b) => a.localeCompare(b))).toEqual([
        'client',
        'client',
        'expert',
        'expert',
      ]);
      // Assignee-only — the admins are never a recipient.
      expect(rules!.some((r) => r.recipient === 'admin_users')).toBe(false);
      // No SMS — each side gets email + in-app.
      expect(rules!.filter((r) => r.channel === 'email')).toHaveLength(2);
      expect(rules!.filter((r) => r.channel === 'in-app')).toHaveLength(2);
    });

    it('routes by payload.assigneeParty — only the assigned side fires', () => {
      const rules = notificationRules['action_item.assigned']!;
      const clientRule = rules.find((r) => r.recipient === 'client')!;
      const expertRule = rules.find((r) => r.recipient === 'expert')!;

      const toClient = {
        event: 'action_item.assigned',
        payload: { assigneeParty: 'client' },
        data: {},
      };
      expect(clientRule.condition!(toClient)).toBe(true);
      expect(expertRule.condition!(toClient)).toBe(false);

      const toExpert = {
        event: 'action_item.assigned',
        payload: { assigneeParty: 'expert' },
        data: {},
      };
      expect(clientRule.condition!(toExpert)).toBe(false);
      expect(expertRule.condition!(toExpert)).toBe(true);
    });
  });

  describe('BAL-412 (ADR-1044 §7, D8) session.missed_call', () => {
    it('gives each of the two recipients (self, expert) email + in-app — 4 rules, no admin fan-out', () => {
      const rules = notificationRules['session.missed_call'];
      expect(rules).toBeDefined();
      expect(rules).toHaveLength(4); // (self: email+in-app) + (expert: email+in-app)
      expect(rules!.map((r) => r.recipient).sort((a, b) => a.localeCompare(b))).toEqual([
        'expert',
        'expert',
        'self',
        'self',
      ]);
      expect(rules!.filter((r) => r.channel === 'email')).toHaveLength(2);
      expect(rules!.filter((r) => r.channel === 'in-app')).toHaveLength(2);
      // No SMS, no admin fan-out.
      expect(rules!.some((r) => r.channel === 'sms')).toBe(false);
      expect(rules!.some((r) => r.recipient === 'admin_users')).toBe(false);
      expect(rules!.some((r) => r.recipient === 'company_billing_admins')).toBe(false);
    });

    it('uses the distinct apologetic/factual templates per recipient', () => {
      const rules = notificationRules['session.missed_call']!;
      const selfRules = rules.filter((r) => r.recipient === 'self');
      const expertRules = rules.filter((r) => r.recipient === 'expert');
      expect(selfRules.every((r) => r.template === 'session-missed-call-client')).toBe(true);
      expect(expertRules.every((r) => r.template === 'session-missed-call-expert')).toBe(true);
    });

    it('is UNCONDITIONED — both recipients always fire (a missed call always names both parties)', () => {
      const rules = notificationRules['session.missed_call']!;
      expect(rules.every((r) => r.condition === undefined)).toBe(true);
    });
  });

  describe('BAL-390 review & rating', () => {
    /** Narrow by destructure + guard — `noUncheckedIndexedAccess` is on. */
    function rulesFor(event: string): NotificationRule[] {
      const rules = notificationRules[event];
      if (rules === undefined) throw new Error(`no rules registered for ${event}`);
      return rules;
    }

    it('review.reminder: EMAIL ONLY to the reviewer (recipient self, template review-nudge)', () => {
      const rules = rulesFor('review.reminder');
      expect(rules).toHaveLength(1);
      const [rule] = rules;
      expect(rule).toMatchObject({
        channel: 'email',
        recipient: 'self',
        template: 'review-nudge',
        timing: 'immediate',
        priority: 'normal',
      });
      // The ask IS the in-email star row — an in-app copy would carry neither stars
      // nor token, so there must not be one.
      expect(rules.some((r) => r.channel !== 'email')).toBe(false);
      expect(rule?.condition).toBeUndefined();
    });

    it('does NOT collide with BAL-338 engagement.review_reminder', () => {
      // The regression guard for the naming collision this ticket had to walk around:
      // two different events, two different templates, neither consolidated.
      const legacy = rulesFor('engagement.review_reminder');
      for (const rule of legacy) {
        expect(rule.template).toBe('engagement-review-reminder-client');
      }
      expect(legacy.map((r) => r.recipient)).toEqual(['client', 'client']);
      for (const rule of rulesFor('review.reminder')) {
        expect(rule.template).not.toBe('engagement-review-reminder-client');
      }
    });

    it('engagement.case_closed: client email + in-app, gated on recipientId, no admin fan-out', () => {
      const rules = rulesFor('engagement.case_closed');
      expect(rules).toHaveLength(2);
      for (const rule of rules) {
        expect(rule.recipient).toBe('client');
        expect(rule.template).toBe('engagement-case-closed-client');
        expect(rule.timing).toBe('immediate');
        expect(rule.condition).toBeDefined();
      }
      expect(rules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
      expect(rules.some((r) => r.recipient === 'admin_users')).toBe(false);
    });

    it('engagement.case_closed skips when no client-side reviewer resolved', () => {
      const [rule] = rulesFor('engagement.case_closed');
      const condition = rule?.condition;
      expect(condition).toBeDefined();
      const base = { event: 'engagement.case_closed', data: {} };
      expect(condition?.({ ...base, payload: { recipientId: 'user-1' } })).toBe(true);
      expect(condition?.({ ...base, payload: {} })).toBe(false);
    });

    it('engagement.accepted now emails the ACCEPTING client too (recipient self)', () => {
      // BAL-390 deliberately overturns BAL-338's "No client recipient (they just
      // acted)": actor-gets-a-receipt is the house pattern at money moments
      // (payment.charged / credit.topup.completed / promo.redeemed).
      const rules = rulesFor('engagement.accepted');
      expect(rules).toHaveLength(5);
      const selfRules = rules.filter((r) => r.recipient === 'self');
      expect(selfRules).toHaveLength(1);
      const [selfRule] = selfRules;
      expect(selfRule).toMatchObject({
        channel: 'email',
        template: 'engagement-accepted-client',
        timing: 'immediate',
      });
      // The expert + admin fan-out is untouched.
      expect(rules.filter((r) => r.recipient === 'expert')).toHaveLength(2);
      expect(rules.filter((r) => r.recipient === 'admin_users')).toHaveLength(2);
    });

    it('engagement.accepted client email is gated on payload.userId', () => {
      const rules = rulesFor('engagement.accepted');
      const selfRule = rules.find((r) => r.recipient === 'self');
      const condition = selfRule?.condition;
      expect(condition).toBeDefined();
      const base = { event: 'engagement.accepted', data: {} };
      expect(condition?.({ ...base, payload: { userId: 'user-1' } })).toBe(true);
      // An older publisher that supplies no acting user must skip, not send a
      // half-populated acceptance record.
      expect(condition?.({ ...base, payload: {} })).toBe(false);
    });

    it('engagement.auto_accepted keeps its rule unchanged (the star row is fused, not added)', () => {
      const rules = rulesFor('engagement.auto_accepted');
      expect(rules).toHaveLength(6);
      const clientRules = rules.filter((r) => r.recipient === 'client');
      expect(clientRules).toHaveLength(2);
      for (const rule of clientRules) {
        expect(rule.template).toBe('engagement-auto-accepted-client');
      }
    });
  });

  describe('BAL-408 / ADR-1044 guest participation', () => {
    /** Narrow by destructure + guard — `noUncheckedIndexedAccess` is on. */
    function guestRulesFor(event: string): NotificationRule[] {
      const rules = notificationRules[event];
      if (rules === undefined) throw new Error(`no rules registered for ${event}`);
      return rules;
    }

    it('meeting.guest_invited: EMAIL ONLY, to the external `email_address`', () => {
      // ⚠ The recipient is an EXTERNAL person with no Balo user row, so there is no `self` /
      // `client` / `expert` to hydrate and no in-app surface to render on. The dispatcher
      // reads `payload.recipientEmail` — the `expert.referral_invited` / `proposal.shared`
      // path. ⚠ AND EXACTLY ONE RULE: the payload carries that guest's RAW join token, and a
      // second rule (or a fan-out recipient kind) would share one payload across recipients.
      const rules = guestRulesFor('meeting.guest_invited');

      expect(rules).toHaveLength(1);
      const [rule] = rules;
      expect(rule).toMatchObject({
        channel: 'email',
        recipient: 'email_address',
        template: 'meeting-guest-invited',
        timing: 'immediate',
        priority: 'normal',
      });
      expect(rule?.condition).toBeUndefined();
    });

    it('meeting.guest_added: IN-APP ONLY, to `meeting_party_participants`', () => {
      // ⚠ THE ID LIST IS RESOLVED BY THE PUBLISHER (`payload.recipientUserIds`), never by
      // `engine/resolver.ts` — which is what keeps a `meeting_guests` read out of the
      // notification engine. IN-APP only: an email per added colleague would be noise.
      const rules = guestRulesFor('meeting.guest_added');

      expect(rules).toHaveLength(1);
      const [rule] = rules;
      expect(rule).toMatchObject({
        channel: 'in-app',
        recipient: 'meeting_party_participants',
        template: 'meeting-guest-added',
        timing: 'immediate',
      });
      // Deliberately NOT critical, and deliberately not emailed.
      expect(rules.some((r) => r.channel === 'email')).toBe(false);
    });

    it('meeting.guest_removed: EMAIL ONLY, to that person and only that person', () => {
      const rules = guestRulesFor('meeting.guest_removed');

      expect(rules).toHaveLength(1);
      const [rule] = rules;
      expect(rule).toMatchObject({
        channel: 'email',
        recipient: 'email_address',
        template: 'meeting-guest-removed',
        timing: 'immediate',
        priority: 'normal',
      });
      // ⚠ No same-party FYI on removal. Adding one would tell the roster about a colleague's
      // withdrawal, which is the inviter's business to communicate, not the engine's.
      expect(rules.some((r) => r.recipient === 'meeting_party_participants')).toBe(false);
    });

    /**
     * ⚠⚠ BAL-436 — THE SHAPE TEST FOR THE RE-SEND, AND IT IS A **SAFETY** PROPERTY RATHER THAN
     * A TIDINESS ONE. `meeting.guest_link_resent`'s payload carries a freshly ROTATED RAW join
     * token, and the dispatcher shares ONE payload across a fan-out. So a second rule here — or
     * a fan-out recipient kind such as `meeting_party_participants` — would email a live
     * credential for a stranger's row to every member of the meeting's party. Without this
     * test that widening ships green: the rule table has no type-level bound on recipient kind.
     */
    it('⚠⚠ meeting.guest_link_resent: EMAIL ONLY, to that person and NOBODY else', () => {
      const rules = guestRulesFor('meeting.guest_link_resent');

      expect(rules).toHaveLength(1);
      const [rule] = rules;
      expect(rule).toMatchObject({
        channel: 'email',
        recipient: 'email_address',
        template: 'meeting-guest-link-resent',
        timing: 'immediate',
        priority: 'normal',
      });
      // ⚠ NO CONDITION. A conditional rule is one a future edit can make not fire at all —
      // and the whole point of this event is that somebody is stuck outside a live call.
      expect(rule?.condition).toBeUndefined();
      // ⚠⚠ NOT A FAN-OUT, RESTATED AS ITS OWN ASSERTION so widening the recipient fails here
      // rather than in production. `email_address` reads `payload.recipientEmail` — exactly one
      // external inbox, the one that row belongs to.
      expect(rules.every((r) => r.recipient === 'email_address')).toBe(true);
      expect(rules.some((r) => r.channel === 'in-app')).toBe(false);
    });

    it('⚠ there is NO rule key for admit or deny — and that is a product decision', () => {
      // The person is standing in the lobby watching the UI: an email after a DENY is
      // hostile, and one after an ADMIT is redundant with the door opening in front of them.
      // A rule added here would be a regression, not a gap.
      const guestKeys = Object.keys(notificationRules)
        .filter((key) => key.startsWith('meeting.guest'))
        .sort((a, b) => a.localeCompare(b));

      expect(guestKeys).toEqual([
        'meeting.guest_added',
        'meeting.guest_invited',
        // ⚠ BAL-436. A RE-SEND is not an admit: it is a host deliberately asking us to mail a
        // fresh credential to somebody who is already through the door and stuck outside the
        // room. The email IS the act, so it has a rule — which is the opposite of the two
        // decisions below, where the door opening in front of the person IS the notification.
        'meeting.guest_link_resent',
        'meeting.guest_removed',
        // ⚠ BAL-409. A booked consultation MOVED — the guest is not in a lobby for this one,
        // they are told by email ahead of time, same reasoning as `meeting.guest_invited`.
        'meeting.guest_rescheduled',
      ]);
      for (const key of [
        'meeting.guest_admitted',
        'meeting.guest_denied',
        'meeting.guest_admission_decided',
      ]) {
        expect(notificationRules[key]).toBeUndefined();
      }
    });

    it('⚠ `meeting_party_participants` is used by the guest FYI, the BAL-134 client nudge and BAL-411', () => {
      // A new fan-out KIND is a dispatcher branch; pinning its consumers means a future reuse
      // has to come past this test and state itself. BAL-134 is the SECOND consumer and BAL-411
      // is the THIRD/FOURTH: both the proposal-sent notice and its unanswered reminder fan out
      // to the client company's members the same way — resolved by the PUBLISHER (or the
      // fire-time recheck) into `payload.recipientUserIds`, keeping a membership read out of
      // `engine/resolver.ts`.
      const users = Object.entries(notificationRules)
        .filter(([, rules]) => rules.some((r) => r.recipient === 'meeting_party_participants'))
        .map(([event]) => event);

      expect(users).toEqual([
        'reschedule_proposal.sent',
        'reschedule_proposal.unanswered',
        'meeting.guest_added',
        'meeting.client_absent',
      ]);
    });

    /**
     * ⚠⚠ BAL-134 — THE CLIENT NUDGE HAS **NO SMS ARM**, AND ITS ABSENCE IS ASSERTED (D13). The
     * AC says "SMS + in-app"; two INDEPENDENT structural blocks in the shipped code make it
     * unbuildable: `processSmsJob` resolves the number from
     * `usersRepository.findById(payload.recipientId).phone` (a guest or delegate with no user
     * row is unreachable BY CONSTRUCTION), and the `recipientPhoneVerified` gate reads
     * `ctx.data.user`, which the resolver hydrates only on the SINGLE-RECIPIENT path — never on
     * a fan-out, which is what this nudge is. Adding an SMS arm before those are fixed would
     * queue jobs that can never resolve a number, so this test is the guard rather than a note.
     */
    it('⚠ `meeting.client_absent` ships in-app + email and NO sms (D13 — deferred, not dropped)', () => {
      const rules = notificationRules['meeting.client_absent'] ?? [];

      expect(rules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
      expect(rules.some((r) => r.channel === 'sms')).toBe(false);
      expect(rules.every((r) => r.template === 'meeting-client-absent')).toBe(true);
    });

    /**
     * ⚠ THE BALO-STAFF PATH IS THE SHIPPED `recipient: 'admin'` ONE — the ticket's "this may
     * need a separate path rather than a new template" is wrong. `dispatcher.ts` resolves it to
     * the literal `OPS_NOTIFICATION_EMAIL`; the precedent is `project.match_requested`.
     */
    it('⚠ `meeting.expert_absent` is a CRITICAL admin email — the shipped ops path, not a new one', () => {
      expect(notificationRules['meeting.expert_absent']).toEqual([
        {
          channel: 'email',
          recipient: 'admin',
          template: 'meeting-expert-absent-admin',
          timing: 'immediate',
          priority: 'critical',
        },
      ]);
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

  describe('BAL-411 reschedule proposal events', () => {
    it('reschedule_proposal.sent ships email + in-app + a CONDITIONED, CRITICAL sms arm', () => {
      const rules = notificationRules['reschedule_proposal.sent'] ?? [];
      expect(rules).toHaveLength(3);
      expect(rules.every((r) => r.recipient === 'meeting_party_participants')).toBe(true);
      expect(
        rules.every(
          (r) =>
            r.template === 'reschedule-proposal-sent' ||
            r.template === 'reschedule-proposal-sent-sms'
        )
      ).toBe(true);

      const sms = rules.find((r) => r.channel === 'sms');
      expect(sms).toBeDefined();
      expect(sms!.priority).toBe('critical');
      expect(sms!.template).toBe('reschedule-proposal-sent-sms');
      expect(sms!.condition).toBeDefined();

      const email = rules.find((r) => r.channel === 'email');
      const inApp = rules.find((r) => r.channel === 'in-app');
      expect(email?.condition).toBeUndefined();
      expect(inApp?.condition).toBeUndefined();
    });

    it('the sms arm fires ONLY when hoursToStart < 2', () => {
      const rules = notificationRules['reschedule_proposal.sent'] ?? [];
      const sms = rules.find((r) => r.channel === 'sms')!;
      const base = { event: 'reschedule_proposal.sent', data: {} };
      expect(sms.condition!({ ...base, payload: { hoursToStart: 1.9 } })).toBe(true);
      expect(sms.condition!({ ...base, payload: { hoursToStart: 2 } })).toBe(false);
      expect(sms.condition!({ ...base, payload: { hoursToStart: 5 } })).toBe(false);
      expect(sms.condition!({ ...base, payload: {} })).toBe(false);
    });

    // Item 5 — the publisher now emits a FRACTIONAL `hoursToStart` (never `Math.round`ed), so
    // the boundary this condition actually has to hold at run time is a fraction just under 2,
    // not the whole number `1.9` above. Pin it precisely: a propose at 1h50m out (1.8333h,
    // exactly what `Math.round` used to bump to 2) must still fire, and 2.0 exactly must not.
    it('boundary: 1.99 fires, 2.0 exactly does not', () => {
      const rules = notificationRules['reschedule_proposal.sent'] ?? [];
      const sms = rules.find((r) => r.channel === 'sms')!;
      const base = { event: 'reschedule_proposal.sent', data: {} };
      expect(sms.condition!({ ...base, payload: { hoursToStart: 1.99 } })).toBe(true);
      expect(sms.condition!({ ...base, payload: { hoursToStart: 11 / 6 } })).toBe(true); // 1h50m
      expect(sms.condition!({ ...base, payload: { hoursToStart: 2.0 } })).toBe(false);
    });

    it('reschedule_proposal.declined ships email + in-app to the expert, no sms, no admin fan-out', () => {
      const rules = notificationRules['reschedule_proposal.declined'] ?? [];
      expect(rules).toHaveLength(2);
      expect(rules.every((r) => r.recipient === 'expert')).toBe(true);
      expect(rules.every((r) => r.template === 'reschedule-proposal-declined')).toBe(true);
      expect(rules.map((r) => r.channel).sort((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'in-app',
      ]);
    });

    it('reschedule_proposal.unanswered is IN-APP ONLY, to meeting_party_participants', () => {
      expect(notificationRules['reschedule_proposal.unanswered']).toEqual([
        {
          channel: 'in-app',
          recipient: 'meeting_party_participants',
          template: 'reschedule-proposal-unanswered',
          timing: 'immediate',
        },
      ]);
    });
  });
});
