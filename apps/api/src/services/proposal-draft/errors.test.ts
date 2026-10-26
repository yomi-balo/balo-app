import { describe, it, expect } from 'vitest';
import { ProposalDraftGenerationError } from './errors.js';

describe('ProposalDraftGenerationError', () => {
  it('carries the classified reason, message and cause', () => {
    const cause = new Error('underlying');
    const error = new ProposalDraftGenerationError('truncated', 'too long', cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProposalDraftGenerationError');
    expect(error.reason).toBe('truncated');
    expect(error.message).toBe('too long');
    expect(error.cause).toBe(cause);
  });
});
