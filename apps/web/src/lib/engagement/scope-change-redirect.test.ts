import { describe, it, expect } from 'vitest';
import {
  changeOrderPrefillHref,
  parseChangeOrderPrefill,
  scopeChangeMessage,
  type ChangeOrderPrefill,
} from './scope-change-redirect';

const HREF = '/engagements/e1/change-order';
const MILESTONE = '3f1c2b4e-8a6d-4c1e-9f2a-5b7d8e9f0a1b';

function roundTrip(prefill: ChangeOrderPrefill): ChangeOrderPrefill | null {
  const href = changeOrderPrefillHref(HREF, prefill);
  const params = Object.fromEntries(new URL(href, 'https://x.test').searchParams);
  return parseChangeOrderPrefill(params);
}

describe('scopeChangeMessage', () => {
  it.each(['estimate_change', 'add_on_tm', 'remove_contracted'] as const)(
    'names the client company for %s',
    (reason) => {
      expect(scopeChangeMessage(reason, 'Northwind')).toContain('Northwind');
    }
  );
});

describe('changeOrderPrefillHref', () => {
  it('returns the bare href for no prefill', () => {
    expect(changeOrderPrefillHref(HREF, null)).toBe(HREF);
  });

  it('round-trips a remove', () => {
    expect(roundTrip({ op: 'remove', milestoneId: MILESTONE })).toEqual({
      op: 'remove',
      milestoneId: MILESTONE,
    });
  });

  it('round-trips an add with a title', () => {
    const add: ChangeOrderPrefill = { op: 'add', title: 'Reporting & KPIs' };
    expect(roundTrip(add)).toEqual(add);
  });

  it('round-trips a bare add', () => {
    expect(roundTrip({ op: 'add' })).toEqual({ op: 'add' });
  });

  it('never carries a description in the link', () => {
    const href = changeOrderPrefillHref(HREF, { op: 'add', title: 'Big' });
    expect(href).toContain('title=Big');
    expect(href).not.toContain('description');
  });
});

describe('parseChangeOrderPrefill', () => {
  it.each([
    {},
    { prefill: 'edit' },
    { prefill: 'remove' },
    { prefill: 'remove', milestone: 'nope' },
    { prefill: 'add', title: 'x'.repeat(201) },
  ])('returns null for invalid input %j', (params) => {
    expect(parseChangeOrderPrefill(params)).toBeNull();
  });

  it('takes the first value of a repeated param', () => {
    expect(parseChangeOrderPrefill({ prefill: ['remove', 'add'], milestone: [MILESTONE] })).toEqual(
      {
        op: 'remove',
        milestoneId: MILESTONE,
      }
    );
  });
});
