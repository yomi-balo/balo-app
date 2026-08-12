import { describe, it, expect } from 'vitest';
import type { RecapContextType } from '@balo/analytics/events';
import { contextIsCase, resolveEyebrow } from './resolve-eyebrow';

const ALL_CONTEXTS: readonly RecapContextType[] = [
  'case',
  'project_discovery',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'request_interaction',
];

describe('resolveEyebrow', () => {
  it('labels every reachable context type', () => {
    expect(resolveEyebrow('case')).toBe('Consultation');
    expect(resolveEyebrow('project_discovery')).toBe('Discovery call');
    expect(resolveEyebrow('project_kickoff')).toBe('Project kickoff');
    expect(resolveEyebrow('package_session')).toBe('Package session');
    expect(resolveEyebrow('retainer_checkin')).toBe('Retainer check-in');
    // D-D: request_interaction RENDERS, as an intro call. The wording is on the MJ copy list;
    // the RENDERING ruling is not.
    expect(resolveEyebrow('request_interaction')).toBe('Intro call');
  });

  it('never falls through to a raw enum value', () => {
    for (const contextType of ALL_CONTEXTS) {
      const label = resolveEyebrow(contextType);
      expect(label).not.toContain('_');
      // SENTENCE CASE IS STORED; the ALL-CAPS look is CSS `uppercase`. Storing shouted strings
      // makes assistive tech spell short labels out letter by letter.
      expect(label).not.toBe(label.toUpperCase());
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });
});

describe('contextIsCase', () => {
  it('is true only for a case', () => {
    expect(contextIsCase('case')).toBe(true);
    for (const contextType of ALL_CONTEXTS.filter((value) => value !== 'case')) {
      expect(contextIsCase(contextType)).toBe(false);
    }
  });
});
