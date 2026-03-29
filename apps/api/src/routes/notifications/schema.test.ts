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
