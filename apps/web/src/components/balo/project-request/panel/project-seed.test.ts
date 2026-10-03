import { describe, it, expect } from 'vitest';
import { validateDescription } from '@/components/balo/rich-text/plain-text';
import {
  descriptionTextToHtml,
  freshDraftFields,
  hasOwnContent,
  initialStepFor,
  isNewSearch,
  isSeedEmpty,
  mergeSeedProductIds,
  seedProductsChanged,
  seedSearchText,
  seedTextPatch,
  type ProjectRequestSeed,
} from './project-seed';
import type { ProjectDraft } from './use-project-draft';

const EMPTY_TEXT_DRAFT: Pick<ProjectDraft, 'title' | 'descriptionHtml'> = {
  title: '',
  descriptionHtml: '',
};

describe('descriptionTextToHtml', () => {
  it('escapes &, < and > and wraps a single <p>', () => {
    expect(descriptionTextToHtml('<b>&"x')).toBe('<p>&lt;b&gt;&amp;"x</p>');
  });

  it('passes validateDescription once the plain text is long enough', () => {
    const text = 'a'.repeat(121);
    expect(validateDescription(descriptionTextToHtml(text))).toBeNull();
  });

  it('does NOT pass validateDescription for a too-short text', () => {
    expect(validateDescription(descriptionTextToHtml('short'))).not.toBeNull();
  });
});

describe('seedTextPatch (a seed that CONTINUES the draft — fills blanks only)', () => {
  it('fills an empty title', () => {
    const patch = seedTextPatch(EMPTY_TEXT_DRAFT, { title: 'Migrate to Sales Cloud' });
    expect(patch.title).toBe('Migrate to Sales Cloud');
  });

  it('fills a whitespace-only title', () => {
    const patch = seedTextPatch({ ...EMPTY_TEXT_DRAFT, title: '   ' }, { title: 'A real title' });
    expect(patch.title).toBe('A real title');
  });

  it('keeps an existing title (an edit made in the panel)', () => {
    const patch = seedTextPatch(
      { ...EMPTY_TEXT_DRAFT, title: 'Edited in the panel' },
      { title: 'Seeded title' }
    );
    expect(patch.title).toBeUndefined();
  });

  it('treats a cleared editor\'s "<p></p>" as empty and fills the description', () => {
    const patch = seedTextPatch(
      { ...EMPTY_TEXT_DRAFT, descriptionHtml: '<p></p>' },
      { descriptionText: 'We need help scoping this.' }
    );
    expect(patch.descriptionHtml).toBe('<p>We need help scoping this.</p>');
  });

  it('keeps an existing description', () => {
    const patch = seedTextPatch(
      { ...EMPTY_TEXT_DRAFT, descriptionHtml: '<p>Edited in the panel</p>' },
      { descriptionText: 'Seeded description' }
    );
    expect(patch.descriptionHtml).toBeUndefined();
  });

  it('returns an empty patch for a seed with no text', () => {
    const patch = seedTextPatch(EMPTY_TEXT_DRAFT, { productIds: ['p1'] });
    expect(patch).toEqual({});
  });
});

const EMPTY_DRAFT: ProjectDraft = {
  routing: 'match',
  title: '',
  descriptionHtml: '',
  tagIds: [],
  productIds: [],
  documents: [],
  budgetMinCents: null,
  budgetMaxCents: null,
  timeline: null,
  caseFileSelections: {},
  caseBriefSnapshot: null,
  source: 'manual',
  seededFrom: null,
};

describe('seedSearchText', () => {
  it.each<[ProjectRequestSeed, string | null]>([
    [{ title: 'short' }, 'short'],
    [{ descriptionText: 'long' }, 'long'],
    [{ productIds: ['p1'] }, null],
    [{}, null],
  ])('%j -> %j', (seed, expected) => {
    expect(seedSearchText(seed)).toBe(expected);
  });
});

describe('isNewSearch', () => {
  const titled = { ...EMPTY_DRAFT, title: 'Old project title' };

  it('a search that differs from a title saved on an earlier visit is NEW', () => {
    expect(isNewSearch(titled, { title: 'Migrate from Tableau' })).toBe(true);
  });

  it('a LONG search (description seed) is new against a saved draft too', () => {
    expect(isNewSearch(titled, { descriptionText: 'A long brief' })).toBe(true);
  });

  it('the search that STARTED the draft continues it — even after its title was edited', () => {
    const edited = {
      ...EMPTY_DRAFT,
      title: 'Edited in the panel',
      seededFrom: { text: 'Migrate CPQ', productIds: [] },
    };
    expect(isNewSearch(edited, { title: 'Migrate CPQ' })).toBe(false);
  });

  it('the long search that started the draft continues it — even after its brief was edited', () => {
    const edited = {
      ...EMPTY_DRAFT,
      descriptionHtml: '<p>Edited brief</p>',
      seededFrom: { text: 'Same long search', productIds: [] },
    };
    expect(isNewSearch(edited, { descriptionText: 'Same long search' })).toBe(false);
  });

  it('a different search is new even though a search started the draft', () => {
    const seeded = {
      ...EMPTY_DRAFT,
      title: 'First search',
      seededFrom: { text: 'First search', productIds: [] },
    };
    expect(isNewSearch(seeded, { title: 'Another search' })).toBe(true);
  });

  it('a draft no search started, already titled with this search (trimmed), continues', () => {
    expect(isNewSearch({ ...EMPTY_DRAFT, title: '  Same  ' }, { title: 'Same' })).toBe(false);
  });

  it('a draft no search started, already holding this long search as its brief, continues', () => {
    const draft = { ...EMPTY_DRAFT, descriptionHtml: '<p>A long brief</p>' };
    expect(isNewSearch(draft, { descriptionText: 'A long brief' })).toBe(false);
  });

  it('a seed with no text (products from chips alone) is never new', () => {
    expect(isNewSearch(titled, { productIds: ['p1'] })).toBe(false);
  });
});

describe('freshDraftFields', () => {
  it('a short search is the title, with an empty brief, and records its search + chips', () => {
    expect(freshDraftFields({ title: 'Migrate', productIds: ['p1'] })).toEqual({
      title: 'Migrate',
      descriptionHtml: '',
      seededFrom: { text: 'Migrate', productIds: ['p1'] },
    });
  });

  it('a long search is the escaped brief, with an EMPTY title (never a stale one)', () => {
    expect(freshDraftFields({ descriptionText: 'Move <all> reports' })).toEqual({
      title: '',
      descriptionHtml: '<p>Move &lt;all&gt; reports</p>',
      seededFrom: { text: 'Move <all> reports', productIds: [] },
    });
  });
});

describe('seedProductsChanged', () => {
  const seeded = { seededFrom: { text: 'x', productIds: ['a', 'b'] } };

  it('the same chips, in any order, are unchanged', () => {
    expect(seedProductsChanged(seeded, { productIds: ['b', 'a'] })).toBe(false);
  });

  it('an added or removed chip is a change', () => {
    expect(seedProductsChanged(seeded, { productIds: ['a', 'b', 'c'] })).toBe(true);
    expect(seedProductsChanged(seeded, { productIds: ['a'] })).toBe(true);
  });

  it('no chips against a draft no search seeded is unchanged; any chip is a change', () => {
    expect(seedProductsChanged({ seededFrom: null }, {})).toBe(false);
    expect(seedProductsChanged({ seededFrom: null }, { productIds: ['a'] })).toBe(true);
  });
});

describe('hasOwnContent', () => {
  it('an empty draft has none — routing, source and a cleared editor do not count', () => {
    expect(hasOwnContent(EMPTY_DRAFT)).toBe(false);
    expect(
      hasOwnContent({
        ...EMPTY_DRAFT,
        routing: 'direct',
        source: 'ai',
        descriptionHtml: '<p></p>',
        title: '  ',
      })
    ).toBe(false);
  });

  it('what the search seeded is not the visitor’s own: its title, brief and chip products', () => {
    const origin = { text: 'Migrate CPQ', productIds: ['p1'] };
    expect(
      hasOwnContent({
        ...EMPTY_DRAFT,
        title: 'Migrate CPQ',
        productIds: ['p1'],
        seededFrom: origin,
      })
    ).toBe(false);
    expect(
      hasOwnContent({
        ...EMPTY_DRAFT,
        descriptionHtml: '<p>A long search</p>',
        seededFrom: { text: 'A long search', productIds: [] },
      })
    ).toBe(false);
  });

  it.each<[string, Partial<ProjectDraft>]>([
    ['an edited title', { title: 'Edited' }],
    ['a written brief', { descriptionHtml: '<p>My own brief</p>' }],
    ['a product beyond the chips', { productIds: ['p1', 'p2'] }],
    ['tags', { tagIds: ['t1'] }],
    [
      'documents',
      {
        documents: [
          { r2Key: 'k', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 },
        ],
      },
    ],
    ['a budget minimum (even 0)', { budgetMinCents: 0 }],
    ['a budget maximum', { budgetMaxCents: 100 }],
    ['a timeline', { timeline: '6 weeks' }],
  ])('counts %s', (_label, patch) => {
    const seeded = {
      ...EMPTY_DRAFT,
      title: 'Migrate CPQ',
      productIds: ['p1'],
      seededFrom: { text: 'Migrate CPQ', productIds: ['p1'] },
    };
    expect(hasOwnContent({ ...seeded, ...patch })).toBe(true);
  });
});

describe('mergeSeedProductIds', () => {
  const liveIds = new Set(['p1', 'p2', 'p3']);

  it('unions new, live seeded ids onto the draft ids', () => {
    expect(mergeSeedProductIds(['p1'], ['p2'], liveIds)).toEqual(['p1', 'p2']);
  });

  it('keeps the draft ids untouched and in order', () => {
    expect(mergeSeedProductIds(['p3', 'p1'], ['p2'], liveIds)).toEqual(['p3', 'p1', 'p2']);
  });

  it('drops a stale seeded id not present in the live taxonomy', () => {
    expect(mergeSeedProductIds(['p1'], ['stale-id'], liveIds)).toBeNull();
  });

  it('returns null when every seeded id is already in the draft', () => {
    expect(mergeSeedProductIds(['p1', 'p2'], ['p1'], liveIds)).toBeNull();
  });

  it('returns null for an empty seed list', () => {
    expect(mergeSeedProductIds(['p1'], [], liveIds)).toBeNull();
  });

  it('de-duplicates repeated seeded ids', () => {
    expect(mergeSeedProductIds([], ['p1', 'p1'], liveIds)).toEqual(['p1']);
  });
});

describe('isSeedEmpty', () => {
  it('is true for undefined', () => {
    expect(isSeedEmpty(undefined)).toBe(true);
  });

  it('is true for an all-empty seed', () => {
    expect(isSeedEmpty({})).toBe(true);
  });

  it('is false when a title is present', () => {
    expect(isSeedEmpty({ title: 'x' })).toBe(false);
  });

  it('is false when a description is present', () => {
    expect(isSeedEmpty({ descriptionText: 'x' })).toBe(false);
  });

  it('is false when product ids are present', () => {
    expect(isSeedEmpty({ productIds: ['p1'] })).toBe(false);
  });

  it('is true for an empty productIds array', () => {
    expect(isSeedEmpty({ productIds: [] })).toBe(true);
  });
});

describe('initialStepFor', () => {
  const cases: Array<{
    label: string;
    seed: ProjectRequestSeed | undefined;
    resumeDraft: boolean;
    draftSource: ProjectDraft['source'];
    step: 'start' | 'manual' | 'upload';
  }> = [
    {
      label: 'no seed, no resume',
      seed: undefined,
      resumeDraft: false,
      draftSource: 'manual',
      step: 'start',
    },
    {
      label: 'a text seed opens at manual',
      seed: { title: 'Migrate us' },
      resumeDraft: false,
      draftSource: 'manual',
      step: 'manual',
    },
    {
      label: 'a products-only seed opens at manual',
      seed: { productIds: ['p1'] },
      resumeDraft: false,
      draftSource: 'manual',
      step: 'manual',
    },
    {
      label: 'resume + manual-source draft opens at manual',
      seed: undefined,
      resumeDraft: true,
      draftSource: 'manual',
      step: 'manual',
    },
    {
      label: 'resume + ai-source draft opens at upload (gated there)',
      seed: undefined,
      resumeDraft: true,
      draftSource: 'ai',
      step: 'upload',
    },
    {
      label: 'resume wins over an empty seed either way',
      seed: {},
      resumeDraft: true,
      draftSource: 'manual',
      step: 'manual',
    },
  ];

  it.each(cases)('$label', ({ seed, resumeDraft, draftSource, step }) => {
    expect(initialStepFor(seed, resumeDraft, draftSource)).toBe(step);
  });

  // BAL-589 — a case mount has no `start`/`upload` step, so it always opens at `manual`,
  // even over a resumed 'ai'-sourced draft (which, off a case mount, would gate at `upload`).
  it('a case mount with an "ai" resume still opens at manual', () => {
    expect(initialStepFor(undefined, true, 'ai', true)).toBe('manual');
  });

  it('a case mount with no seed and no resume still opens at manual', () => {
    expect(initialStepFor(undefined, false, 'manual', true)).toBe('manual');
  });

  it('a case mount ignores a non-empty seed too — manual wins outright', () => {
    expect(initialStepFor({ title: 'Ignored seed' }, false, 'manual', true)).toBe('manual');
  });

  it('isCaseMount defaults to false, so every existing call site is unaffected', () => {
    expect(initialStepFor(undefined, false, 'manual')).toBe('start');
  });
});
