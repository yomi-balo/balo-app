import { describe, it, expect } from 'vitest';
import { publishBodySchema } from './schema.js';

describe('publishBodySchema', () => {
  describe('user.welcome', () => {
    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          role: 'client',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts expert role', () => {
      const result = publishBodySchema.safeParse({
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          role: 'expert',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing role', () => {
      const result = publishBodySchema.safeParse({
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid role value', () => {
      const result = publishBodySchema.safeParse({
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          role: 'admin',
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-UUID correlationId', () => {
      const result = publishBodySchema.safeParse({
        event: 'user.welcome',
        payload: {
          correlationId: 'not-a-uuid',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          role: 'client',
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('expert.application_submitted', () => {
    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'expert.application_submitted',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440001',
          applicationId: '550e8400-e29b-41d4-a716-446655440000',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing applicationId', () => {
      const result = publishBodySchema.safeParse({
        event: 'expert.application_submitted',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440001',
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('expert.approved', () => {
    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'expert.approved',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440001',
          expertProfileId: '550e8400-e29b-41d4-a716-446655440000',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing expertProfileId', () => {
      const result = publishBodySchema.safeParse({
        event: 'expert.approved',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440001',
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('project.proposal_requested', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440002',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440001',
      relationshipId: '550e8400-e29b-41d4-a716-446655440002',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440003',
      title: 'CPQ implementation',
      initiatedBy: 'client' as const,
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_requested',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('accepts the admin-on-behalf variant with initiatedBy:admin + recipientId (BAL-315)', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_requested',
        payload: {
          ...validPayload,
          initiatedBy: 'admin',
          recipientId: '550e8400-e29b-41d4-a716-446655440004',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing initiatedBy (BAL-315 required discriminant)', () => {
      const { initiatedBy: _initiatedBy, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_requested',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid initiatedBy value', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_requested',
        payload: { ...validPayload, initiatedBy: 'expert' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-UUID recipientId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_requested',
        payload: { ...validPayload, initiatedBy: 'admin', recipientId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a missing relationshipId', () => {
      const { relationshipId: _relationshipId, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_requested',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty title and a title over 200 chars', () => {
      expect(
        publishBodySchema.safeParse({
          event: 'project.proposal_requested',
          payload: { ...validPayload, title: '' },
        }).success
      ).toBe(false);
      expect(
        publishBodySchema.safeParse({
          event: 'project.proposal_requested',
          payload: { ...validPayload, title: 'a'.repeat(201) },
        }).success
      ).toBe(false);
    });
  });

  describe('project.proposal_submitted', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440010',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440011',
      relationshipId: '550e8400-e29b-41d4-a716-446655440012',
      recipientId: '550e8400-e29b-41d4-a716-446655440013',
      expertName: 'Ada Lovelace',
      title: 'CPQ implementation',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_submitted',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing recipientId', () => {
      const { recipientId: _recipientId, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_submitted',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty expertName and a title over 200 chars', () => {
      expect(
        publishBodySchema.safeParse({
          event: 'project.proposal_submitted',
          payload: { ...validPayload, expertName: '' },
        }).success
      ).toBe(false);
      expect(
        publishBodySchema.safeParse({
          event: 'project.proposal_submitted',
          payload: { ...validPayload, title: 'a'.repeat(201) },
        }).success
      ).toBe(false);
    });

    it('rejects a non-UUID correlationId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_submitted',
        payload: { ...validPayload, correlationId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('project.kickoff_approved', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440040',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440041',
      relationshipId: '550e8400-e29b-41d4-a716-446655440042',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440043',
      recipientId: '550e8400-e29b-41d4-a716-446655440044',
      title: 'CPQ implementation',
      expertName: 'Priya Nair',
      clientName: 'Dana Whitfield',
      clientCompanyName: 'Acme Corp',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.kickoff_approved',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing recipientId', () => {
      const { recipientId: _recipientId, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.kickoff_approved',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-UUID expertProfileId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.kickoff_approved',
        payload: { ...validPayload, expertProfileId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty clientName and a title over 200 chars', () => {
      expect(
        publishBodySchema.safeParse({
          event: 'project.kickoff_approved',
          payload: { ...validPayload, clientName: '' },
        }).success
      ).toBe(false);
      expect(
        publishBodySchema.safeParse({
          event: 'project.kickoff_approved',
          payload: { ...validPayload, title: 'a'.repeat(201) },
        }).success
      ).toBe(false);
    });
  });

  describe('project.changes_requested', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440020',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440021',
      relationshipId: '550e8400-e29b-41d4-a716-446655440022',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440023',
      clientName: 'Grace Hopper',
      projectTitle: 'CPQ implementation',
      section: 'pricing',
      note: 'Please reduce the deposit to 30%.',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.changes_requested',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('rejects an invalid section', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.changes_requested',
        payload: { ...validPayload, section: 'overview' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty note', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.changes_requested',
        payload: { ...validPayload, note: '' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-UUID correlationId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.changes_requested',
        payload: { ...validPayload, correlationId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('project.proposal_resubmitted', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440030--v2',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440031',
      relationshipId: '550e8400-e29b-41d4-a716-446655440032',
      recipientId: '550e8400-e29b-41d4-a716-446655440033',
      expertName: 'Ada Lovelace',
      projectTitle: 'CPQ implementation',
      version: 2,
      priceCents: 120000,
      currency: 'aud',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_resubmitted',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a "<uuid>--v2" suffixed correlationId (z.string, not z.uuid)', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_resubmitted',
        payload: {
          ...validPayload,
          correlationId: '550e8400-e29b-41d4-a716-446655440099--v3',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a non-positive version', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_resubmitted',
        payload: { ...validPayload, version: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a missing recipientId', () => {
      const { recipientId: _recipientId, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.proposal_resubmitted',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('project.exploratory_requested', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440050',
      recipientId: '550e8400-e29b-41d4-a716-446655440051',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440050',
      title: 'CPQ implementation',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.exploratory_requested',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing recipientId', () => {
      const { recipientId: _recipientId, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.exploratory_requested',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-UUID recipientId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.exploratory_requested',
        payload: { ...validPayload, recipientId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty title and a title over 200 chars', () => {
      expect(
        publishBodySchema.safeParse({
          event: 'project.exploratory_requested',
          payload: { ...validPayload, title: '' },
        }).success
      ).toBe(false);
      expect(
        publishBodySchema.safeParse({
          event: 'project.exploratory_requested',
          payload: { ...validPayload, title: 'a'.repeat(201) },
        }).success
      ).toBe(false);
    });
  });

  describe('project.expert_invited', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440060',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440061',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440062',
      title: 'CPQ implementation',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.expert_invited',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing expertProfileId', () => {
      const { expertProfileId: _expertProfileId, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.expert_invited',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-UUID correlationId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.expert_invited',
        payload: { ...validPayload, correlationId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('project.eoi_submitted', () => {
    const validPayload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440070',
      recipientId: '550e8400-e29b-41d4-a716-446655440071',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440072',
      title: 'CPQ implementation',
      expertName: 'Ada Lovelace',
    };

    it('accepts a valid payload', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.eoi_submitted',
        payload: validPayload,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a missing expertName', () => {
      const { expertName: _expertName, ...rest } = validPayload;
      const result = publishBodySchema.safeParse({
        event: 'project.eoi_submitted',
        payload: rest,
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty expertName and an expertName over 120 chars', () => {
      expect(
        publishBodySchema.safeParse({
          event: 'project.eoi_submitted',
          payload: { ...validPayload, expertName: '' },
        }).success
      ).toBe(false);
      expect(
        publishBodySchema.safeParse({
          event: 'project.eoi_submitted',
          payload: { ...validPayload, expertName: 'a'.repeat(121) },
        }).success
      ).toBe(false);
    });

    it('rejects a non-UUID recipientId', () => {
      const result = publishBodySchema.safeParse({
        event: 'project.eoi_submitted',
        payload: { ...validPayload, recipientId: 'not-a-uuid' },
      });
      expect(result.success).toBe(false);
    });
  });

  it('rejects calendar.auth_error — a server-only event with no publish arm by design', () => {
    // calendar.auth_error is published only from within the API (never via the
    // /notifications/publish route), so it is intentionally absent from the union.
    const result = publishBodySchema.safeParse({
      event: 'calendar.auth_error',
      payload: {
        correlationId: '550e8400-e29b-41d4-a716-446655440080',
        expertProfileId: '550e8400-e29b-41d4-a716-446655440081',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing event field', () => {
    const result = publishBodySchema.safeParse({
      payload: {
        correlationId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '550e8400-e29b-41d4-a716-446655440000',
        role: 'client',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown event name', () => {
    const result = publishBodySchema.safeParse({
      event: 'unknown.event',
      payload: {
        correlationId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '550e8400-e29b-41d4-a716-446655440000',
      },
    });
    expect(result.success).toBe(false);
  });
});
