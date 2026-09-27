import { describe, it, expect } from 'vitest';
import { validateDescription } from '@/components/balo/rich-text/plain-text';
import {
  descriptionTextToHtml,
  initialStepFor,
  isSeedEmpty,
  mergeSeedProductIds,
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

describe('seedTextPatch', () => {
  it('fills an empty title', () => {
    const patch = seedTextPatch(EMPTY_TEXT_DRAFT, { title: 'Migrate to Sales Cloud' });
    expect(patch.title).toBe('Migrate to Sales Cloud');
  });

  it('fills a whitespace-only title', () => {
    const patch = seedTextPatch({ ...EMPTY_TEXT_DRAFT, title: '   ' }, { title: 'A real title' });
    expect(patch.title).toBe('A real title');
  });

  it('does not overwrite an existing title', () => {
    const patch = seedTextPatch(
      { ...EMPTY_TEXT_DRAFT, title: 'Already typed' },
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

  it('does not overwrite an existing description', () => {
    const patch = seedTextPatch(
      { ...EMPTY_TEXT_DRAFT, descriptionHtml: '<p>Already typed</p>' },
      { descriptionText: 'Seeded description' }
    );
    expect(patch.descriptionHtml).toBeUndefined();
  });

  it('returns an empty patch for a seed with no text', () => {
    const patch = seedTextPatch(EMPTY_TEXT_DRAFT, { productIds: ['p1'] });
    expect(patch).toEqual({});
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
});
