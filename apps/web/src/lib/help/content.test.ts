import { describe, expect, it } from 'vitest';
import { createHelpContent, helpContent } from './content';
import type { HelpGuide } from './types';

function guide(overrides: Partial<HelpGuide> & Pick<HelpGuide, 'slug'>): HelpGuide {
  return {
    title: overrides.slug,
    summary: `About ${overrides.slug}`,
    audience: ['client'],
    category: { client: 'calls' },
    order: 1,
    updated: '2026-10-17',
    related: [],
    intro: [],
    sections: [],
    ...overrides,
  };
}

describe('createHelpContent', () => {
  const guides: HelpGuide[] = [
    guide({ slug: 'b-late', title: 'B late', order: 2 }),
    guide({ slug: 'z-early', title: 'Z early', order: 1 }),
    guide({ slug: 'a-early', title: 'A early', order: 1 }),
    guide({
      slug: 'both',
      title: 'Both',
      audience: ['client', 'expert'],
      category: { client: 'cases-projects', expert: 'projects' },
    }),
    guide({ slug: 'expert-only', audience: ['expert'], category: { expert: 'getting-paid' } }),
  ];
  const content = createHelpContent(guides);

  it('drops categories with no guides and keeps registry order', () => {
    expect(content.listCategories('client').map((group) => group.id)).toEqual([
      'calls',
      'cases-projects',
    ]);
    expect(content.listCategories('expert').map((group) => group.id)).toEqual([
      'projects',
      'getting-paid',
    ]);
  });

  it('sorts a category by order, then title', () => {
    const [calls] = content.listCategories('client');
    expect(calls?.guides.map((item) => item.slug)).toEqual(['a-early', 'z-early', 'b-late']);
  });

  it("lists a dual guide under each side with that side's own category", () => {
    const client = content.listCategories('client').find((group) => group.id === 'cases-projects');
    const expert = content.listCategories('expert').find((group) => group.id === 'projects');
    expect(client?.guides.map((item) => item.slug)).toEqual(['both']);
    expect(expert?.guides.map((item) => item.slug)).toEqual(['both']);
  });

  it('exposes summaries only', () => {
    const [calls] = content.listCategories('client');
    expect(Object.keys(calls?.guides[0] ?? {}).sort()).toEqual([
      'audience',
      'slug',
      'summary',
      'title',
    ]);
  });

  it('finds a guide by slug', () => {
    expect(content.findGuide('both')?.title).toBe('Both');
    expect(content.findGuide('nope')).toBeUndefined();
  });

  it('finds summaries in input order and drops unknown slugs', () => {
    expect(content.findSummaries(['z-early', 'nope', 'a-early']).map((item) => item.slug)).toEqual([
      'z-early',
      'a-early',
    ]);
  });
});

describe('helpContent', () => {
  it('serves the committed module', () => {
    expect(helpContent.listCategories('client')).toEqual(helpContent.listCategories('client'));
    expect(helpContent.findGuide('definitely-not-a-guide')).toBeUndefined();
  });
});
