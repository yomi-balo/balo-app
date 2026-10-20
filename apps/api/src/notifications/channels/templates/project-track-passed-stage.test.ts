import { describe, it, expect } from 'vitest';
import { passedStageClause } from './project-track-passed-stage.js';

describe('passedStageClause (BAL-604)', () => {
  it.each([
    ['invited', 'before responding to the invitation'],
    ['eoi_submitted', 'after expressing interest'],
    ['proposal_requested', 'after a proposal was requested'],
  ])('names the %s stage', (status, phrase) => {
    expect(passedStageClause(status, false)).toBe(` ${phrase}`);
  });

  it('names the direct request instead of the stage on the direct leg', () => {
    expect(passedStageClause('eoi_submitted', true)).toBe(' on a direct request');
    expect(passedStageClause('proposal_requested', true)).toBe(' on a direct request');
  });

  it('falls back to the stage phrase unless onDirectLeg is literally true', () => {
    expect(passedStageClause('eoi_submitted', undefined)).toBe(' after expressing interest');
    expect(passedStageClause('eoi_submitted', 'true')).toBe(' after expressing interest');
  });

  it('is empty for an unknown or non-string stage', () => {
    expect(passedStageClause('proposal_submitted', false)).toBe('');
    expect(passedStageClause(undefined, undefined)).toBe('');
  });
});
