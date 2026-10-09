import { describe, it, expect } from 'vitest';
import { buildExpertApplicationSubmittedPayload } from './expert-application-submitted';

describe('buildExpertApplicationSubmittedPayload', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const expertProfileId = '22222222-2222-4222-8222-222222222222';
  const auditEventId = '33333333-3333-4333-8333-333333333333';

  it('uses the submit audit row id as the correlationId', () => {
    expect(
      buildExpertApplicationSubmittedPayload({ userId, expertProfileId, auditEventId })
    ).toEqual({ correlationId: auditEventId, userId, applicationId: expertProfileId });
  });

  it('gives two submits of one profile two distinct correlationIds', () => {
    const first = buildExpertApplicationSubmittedPayload({ userId, expertProfileId, auditEventId });
    const second = buildExpertApplicationSubmittedPayload({
      userId,
      expertProfileId,
      auditEventId: '44444444-4444-4444-8444-444444444444',
    });
    expect(first.correlationId).not.toBe(second.correlationId);
  });
});
