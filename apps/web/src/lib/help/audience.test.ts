import { describe, expect, it } from 'vitest';
import {
  defaultHelpAudience,
  helpGuideHref,
  helpIndexHref,
  helpSideParam,
  parseHelpSide,
  parseHelpSource,
  resolveGuideSide,
} from './audience';

describe('parseHelpSide', () => {
  it.each([
    ['clients', 'client'],
    ['experts', 'expert'],
    [['experts', 'clients'], 'expert'],
    ['client', null],
    ['', null],
    [undefined, null],
    [[], null],
  ] as const)('%j -> %j', (raw, expected) => {
    expect(parseHelpSide(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe('helpSideParam', () => {
  it('maps an audience to its query value', () => {
    expect(helpSideParam('client')).toBe('clients');
    expect(helpSideParam('expert')).toBe('experts');
  });
});

describe('defaultHelpAudience', () => {
  it('is expert only for an expert workspace', () => {
    expect(defaultHelpAudience({ activeWorkspace: { type: 'expert', key: 'expert' } })).toBe(
      'expert'
    );
  });

  it('is client for a company workspace, a missing workspace, and no user', () => {
    expect(
      defaultHelpAudience({
        activeWorkspace: { type: 'company', key: 'company:c1', companyId: 'c1', name: 'Northwind' },
      })
    ).toBe('client');
    expect(defaultHelpAudience({})).toBe('client');
    expect(defaultHelpAudience(null)).toBe('client');
  });
});

describe('resolveGuideSide', () => {
  it('returns the requested side when the guide lists it', () => {
    expect(resolveGuideSide(['client', 'expert'], 'expert')).toBe('expert');
  });

  it('falls back to the first listed side', () => {
    expect(resolveGuideSide(['expert', 'client'], null)).toBe('client');
    expect(resolveGuideSide(['expert'], 'client')).toBe('expert');
  });
});

describe('parseHelpSource', () => {
  it.each([
    ['index', 'index'],
    ['related', 'related'],
    ['product', 'product'],
    [['related', 'index'], 'related'],
    ['external', 'external'],
    ['bogus', 'external'],
    [undefined, 'external'],
  ] as const)('%j -> %j', (raw, expected) => {
    expect(parseHelpSource(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe('helpIndexHref', () => {
  it('builds the index URL, optionally with a side and a topic anchor', () => {
    expect(helpIndexHref()).toBe('/help');
    expect(helpIndexHref('expert')).toBe('/help?for=experts');
    expect(helpIndexHref('client', 'calls')).toBe('/help?for=clients#topic-calls');
    expect(helpIndexHref(undefined, 'calls')).toBe('/help#topic-calls');
  });
});

describe('helpGuideHref', () => {
  it('builds the guide URL with optional side and source', () => {
    expect(helpGuideHref('booking')).toBe('/help/booking');
    expect(helpGuideHref('booking', { for: 'client', src: 'index' })).toBe(
      '/help/booking?for=clients&src=index'
    );
    expect(helpGuideHref('booking', { src: 'related' })).toBe('/help/booking?src=related');
  });
});
