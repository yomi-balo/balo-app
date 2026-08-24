import { describe, it, expect } from 'vitest';
import { isTerminalProposalFailure } from './is-terminal-proposal-failure';

describe('isTerminalProposalFailure', () => {
  it.each([
    'proposal_not_answerable',
    'proposal_stale',
    'meeting_not_reschedulable',
    'meeting_not_found',
    'case_closed',
  ] as const)('%s is terminal', (code) => {
    expect(isTerminalProposalFailure(code)).toBe(true);
  });

  it.each([
    'slot_unavailable',
    'unauthenticated',
    'invalid_request',
    'not_permitted',
    'rate_limited',
    'unknown',
    'proposal_already_pending',
  ] as const)('%s is not terminal', (code) => {
    expect(isTerminalProposalFailure(code)).toBe(false);
  });
});
