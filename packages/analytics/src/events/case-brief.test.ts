import { describe, it, expect } from 'vitest';
import { CASE_BRIEF_EVENTS } from './case-brief';

describe('CASE_BRIEF_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(CASE_BRIEF_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual(
      ['GENERATED', 'REGENERATED'].sort((a, b) => a.localeCompare(b))
    );
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(CASE_BRIEF_EVENTS.GENERATED).toBe('case_brief_generated');
    expect(CASE_BRIEF_EVENTS.REGENERATED).toBe('case_brief_regenerated');
  });

  it('every value is prefixed case_brief_, per the {feature}_{noun}_{past_tense_verb} convention', () => {
    for (const value of Object.values(CASE_BRIEF_EVENTS)) {
      expect(value).toMatch(/^case_brief_[a-z]+(_[a-z]+)*$/);
    }
  });
});
