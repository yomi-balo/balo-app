import { describe, it, expect } from 'vitest';
import { resolveModelId, AiModelNotAllowedError } from './config.js';

describe('resolveModelId', () => {
  it('permissive (no allowList): returns the override when present', () => {
    expect(resolveModelId({ override: 'claude-opus-5', defaultModelId: 'claude-sonnet-5' })).toBe(
      'claude-opus-5'
    );
  });

  it('permissive (no allowList): returns the default when the override is undefined', () => {
    expect(resolveModelId({ override: undefined, defaultModelId: 'claude-sonnet-5' })).toBe(
      'claude-sonnet-5'
    );
  });

  it('an empty-string override is treated as absent, falling to the default', () => {
    expect(resolveModelId({ override: '', defaultModelId: 'claude-sonnet-5' })).toBe(
      'claude-sonnet-5'
    );
  });

  it('permissive resolution accepts ANY override, even one on no list at all', () => {
    expect(
      resolveModelId({ override: 'some-future-model', defaultModelId: 'claude-sonnet-5' })
    ).toBe('some-future-model');
  });

  it('allow-list present: a member override passes through', () => {
    expect(
      resolveModelId({
        override: 'claude-opus-5',
        defaultModelId: 'claude-sonnet-5',
        allowList: ['claude-sonnet-5', 'claude-opus-5'],
      })
    ).toBe('claude-opus-5');
  });

  it('allow-list present: the default (when no override) must also be a member and passes', () => {
    expect(
      resolveModelId({
        override: undefined,
        defaultModelId: 'claude-opus-5',
        allowList: ['claude-sonnet-5', 'claude-opus-5'],
      })
    ).toBe('claude-opus-5');
  });

  it('allow-list present: a non-member override throws AiModelNotAllowedError', () => {
    expect(() =>
      resolveModelId({
        override: 'gpt-4o',
        defaultModelId: 'claude-sonnet-5',
        allowList: ['claude-sonnet-5', 'claude-opus-5'],
      })
    ).toThrow(AiModelNotAllowedError);
  });

  it('the thrown error names the rejected id and the allow-list', () => {
    try {
      resolveModelId({
        override: 'gpt-4o',
        defaultModelId: 'claude-sonnet-5',
        allowList: ['claude-sonnet-5', 'claude-opus-5'],
      });
      expect.unreachable('resolveModelId should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AiModelNotAllowedError);
      expect((error as Error).message).toContain('gpt-4o');
      expect((error as Error).message).toContain('claude-sonnet-5');
      expect((error as Error).message).toContain('claude-opus-5');
    }
  });
});
