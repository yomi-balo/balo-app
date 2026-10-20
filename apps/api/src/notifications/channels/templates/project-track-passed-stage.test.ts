import { describe, it, expect } from 'vitest';
import { passedStageClause } from './project-track-passed-stage.js';

describe('passedStageClause (BAL-604)', () => {
  it.each([
    ['invited', 'before responding to the invitation'],
    ['eoi_submitted', 'after expressing interest'],
    ['proposal_requested', 'after a proposal was requested'],
  ])('names the %s stage', (status, phrase) => {
    expect(passedStageClause(status)).toBe(` ${phrase}`);
  });

  it('is empty for an unknown or non-string stage', () => {
    expect(passedStageClause('proposal_submitted')).toBe('');
    expect(passedStageClause(undefined)).toBe('');
  });
});
