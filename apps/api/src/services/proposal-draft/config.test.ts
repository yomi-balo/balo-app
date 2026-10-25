import { describe, it, expect, afterEach, vi } from 'vitest';
import { AiModelNotAllowedError } from '../ai/index.js';
import { DEFAULT_PROPOSAL_DRAFT_MODEL, resolveProposalDraftModel } from './config.js';

describe('resolveProposalDraftModel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to claude-sonnet-5', () => {
    vi.stubEnv('PROPOSAL_DRAFT_MODEL', '');
    expect(DEFAULT_PROPOSAL_DRAFT_MODEL).toBe('claude-sonnet-5');
    expect(resolveProposalDraftModel()).toBe('claude-sonnet-5');
  });

  it('accepts an allow-listed override', () => {
    vi.stubEnv('PROPOSAL_DRAFT_MODEL', 'claude-opus-5');
    expect(resolveProposalDraftModel()).toBe('claude-opus-5');
  });

  it('rejects an override outside the allow-list', () => {
    vi.stubEnv('PROPOSAL_DRAFT_MODEL', 'gpt-4');
    expect(() => resolveProposalDraftModel()).toThrow(AiModelNotAllowedError);
  });
});
