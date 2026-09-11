import { describe, it, expect } from 'vitest';
import { LOOKUP_ENTITY_TYPES, LOOKUP_TYPE_FILTERS, type LookupResult } from '@balo/shared/lookup';
import {
  LOOKUP_FILTER_LABEL,
  LOOKUP_FILTER_TYPES,
  LOOKUP_TYPE_ICON,
  LOOKUP_TYPE_LABEL,
  classifyLookupQuery,
  countsByFilter,
  filterByType,
  resolveOpenTarget,
  selectionFromRecent,
  selectionFromResult,
} from './lookup-view';

function result(
  overrides: Partial<LookupResult> & Pick<LookupResult, 'id' | 'type'>
): LookupResult {
  return {
    title: 'Title',
    sub: 'Sub',
    publicExpertUsername: null,
    engagementType: null,
    ...overrides,
  };
}

describe('resolveOpenTarget', () => {
  it('always resolves for a project request', () => {
    const target = resolveOpenTarget(result({ id: 'r1', type: 'project_request' }));
    expect(target).toEqual({ href: '/projects/r1', label: 'Open' });
  });

  it('resolves for a published expert', () => {
    const target = resolveOpenTarget(
      result({ id: 'x1', type: 'expert', publicExpertUsername: 'priya' })
    );
    expect(target).toEqual({ href: '/experts/priya', label: 'Open' });
  });

  it('returns null for an unpublished expert (no username)', () => {
    expect(
      resolveOpenTarget(result({ id: 'x2', type: 'expert', publicExpertUsername: null }))
    ).toBeNull();
  });

  it('returns null for every other type', () => {
    for (const type of ['user', 'company', 'agency', 'credit_session'] as const) {
      expect(resolveOpenTarget(result({ id: 'z', type }))).toBeNull();
    }
  });

  it('resolves for a PROJECT engagement (BAL-555 C1)', () => {
    const target = resolveOpenTarget(
      result({ id: 'e1', type: 'engagement', engagementType: 'project' })
    );
    expect(target).toEqual({ href: '/engagements/e1', label: 'Open' });
  });

  it('returns NULL for a CASE engagement — no admin lens exists (BAL-555 C1)', () => {
    expect(
      resolveOpenTarget(result({ id: 'e2', type: 'engagement', engagementType: 'case' }))
    ).toBeNull();
  });

  it('returns null for an engagement with a null engagementType', () => {
    expect(
      resolveOpenTarget(result({ id: 'e3', type: 'engagement', engagementType: null }))
    ).toBeNull();
  });

  it('covers all seven LOOKUP_ENTITY_TYPES', () => {
    expect(LOOKUP_ENTITY_TYPES).toHaveLength(7);
  });
});

describe('filterByType / countsByFilter', () => {
  const results: LookupResult[] = [
    result({ id: 'u1', type: 'user' }),
    result({ id: 'x1', type: 'expert' }),
    result({ id: 'co1', type: 'company' }),
    result({ id: 'ag1', type: 'agency' }),
    result({ id: 'r1', type: 'project_request' }),
    result({ id: 'e1', type: 'engagement', engagementType: 'project' }),
    result({ id: 's1', type: 'credit_session' }),
  ];

  it('"all" keeps every result', () => {
    expect(filterByType(results, 'all')).toEqual(results);
  });

  it('"people" keeps user + expert', () => {
    expect(filterByType(results, 'people').map((r) => r.id)).toEqual(['u1', 'x1']);
  });

  it('"orgs" keeps company + agency', () => {
    expect(filterByType(results, 'orgs').map((r) => r.id)).toEqual(['co1', 'ag1']);
  });

  it('"sessions" keeps credit_session only', () => {
    expect(filterByType(results, 'sessions').map((r) => r.id)).toEqual(['s1']);
  });

  it('"requests" keeps project_request only', () => {
    expect(filterByType(results, 'requests').map((r) => r.id)).toEqual(['r1']);
  });

  it('"engagements" keeps engagement only', () => {
    expect(filterByType(results, 'engagements').map((r) => r.id)).toEqual(['e1']);
  });

  it('countsByFilter reports a live count per chip', () => {
    expect(countsByFilter(results)).toEqual({
      all: 7,
      people: 2,
      orgs: 2,
      sessions: 1,
      requests: 1,
      engagements: 1,
    });
  });

  it('countsByFilter is all zero except "all" on an empty result set', () => {
    expect(countsByFilter([])).toEqual({
      all: 0,
      people: 0,
      orgs: 0,
      sessions: 0,
      requests: 0,
      engagements: 0,
    });
  });
});

describe('LOOKUP_TYPE_LABEL / LOOKUP_TYPE_ICON / LOOKUP_FILTER_LABEL / LOOKUP_FILTER_TYPES', () => {
  it('has a label for every entity type', () => {
    for (const type of LOOKUP_ENTITY_TYPES) {
      expect(LOOKUP_TYPE_LABEL[type]).toBeTruthy();
    }
  });

  it('has an icon for every entity type', () => {
    for (const type of LOOKUP_ENTITY_TYPES) {
      expect(LOOKUP_TYPE_ICON[type]).toBeDefined();
    }
  });

  it('has a filter-types entry for every LOOKUP_TYPE_FILTERS key', () => {
    for (const filter of LOOKUP_TYPE_FILTERS) {
      expect(filter in LOOKUP_FILTER_TYPES).toBe(true);
      expect(LOOKUP_FILTER_LABEL[filter]).toBeTruthy();
    }
  });

  it('the orgs chip label is "Companies & agencies"', () => {
    expect(LOOKUP_FILTER_LABEL.orgs).toBe('Companies & agencies');
  });

  it('the engagements chip label is "Engagements"', () => {
    expect(LOOKUP_FILTER_LABEL.engagements).toBe('Engagements');
  });
});

describe('classifyLookupQuery', () => {
  it('classifies a full uuid as "id"', () => {
    expect(classifyLookupQuery('3f9a1b2c-1234-4abc-89ab-1234567890ab')).toBe('id');
  });

  it('classifies a pi_-prefixed value as "id"', () => {
    expect(classifyLookupQuery('pi_3NqTEST0001')).toBe('id');
  });

  it('classifies an @-containing value as "email"', () => {
    expect(classifyLookupQuery('dana@northwind.com.au')).toBe('email');
  });

  it('classifies anything else as "name"', () => {
    expect(classifyLookupQuery('Dana Whitfield')).toBe('name');
  });

  it('is a shape heuristic — a uuid-shaped title still classifies as "id" even though it did not necessarily match on id', () => {
    // Documents the heuristic's own limit rather than asserting match provenance.
    expect(classifyLookupQuery('3f9a1b2c-1234-4abc-89ab-1234567890ab')).toBe('id');
  });
});

describe('selectionFromResult / selectionFromRecent', () => {
  it('selectionFromResult carries the live publicExpertUsername through', () => {
    const selection = selectionFromResult(
      result({ id: 'x1', type: 'expert', title: 'Priya', sub: 'x', publicExpertUsername: 'priya' })
    );
    expect(selection).toEqual({
      key: 'expert:x1',
      type: 'expert',
      id: 'x1',
      title: 'Priya',
      sub: 'x',
      publicExpertUsername: 'priya',
      engagementType: null,
      via: 'search',
    });
  });

  it('selectionFromResult carries the live engagementType through', () => {
    const selection = selectionFromResult(
      result({ id: 'e1', type: 'engagement', title: 'CPQ', sub: 'x', engagementType: 'project' })
    );
    expect(selection.engagementType).toBe('project');
  });

  it('selectionFromRecent always carries publicExpertUsername: null (no live Open link from Recent — BAL-551 F12: usernames can be renamed)', () => {
    const selection = selectionFromRecent({
      type: 'expert',
      id: 'x1',
      title: 'Priya',
      sub: 'x',
    });
    expect(selection.publicExpertUsername).toBeNull();
    expect(selection.key).toBe('expert:x1');
    expect(selection.via).toBe('recent');
  });

  it('selectionFromRecent carries a stored engagementType through', () => {
    const selection = selectionFromRecent({
      type: 'engagement',
      id: 'e1',
      title: 'CPQ',
      sub: 'x',
      engagementType: 'project',
    });
    expect(selection.engagementType).toBe('project');
  });

  it('selectionFromRecent normalises a legacy entry with no engagementType to null (BAL-555 — NOT the F12 staleness case: engagement_type is immutable)', () => {
    const selection = selectionFromRecent({
      type: 'engagement',
      id: 'e1',
      title: 'CPQ',
      sub: 'x',
    });
    expect(selection.engagementType).toBeNull();
  });
});
