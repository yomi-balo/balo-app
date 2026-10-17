import { describe, expect, it } from 'vitest';
import { helpDoc } from './doc-fixtures';
import type { HelpDocIssueCode } from './types';
import { validateHelpDocs } from './validate';

const allExist = (): boolean => true;
const noneExist = (): boolean => false;

function codes(
  files: Parameters<typeof validateHelpDocs>[0],
  imageExists: (publicPath: string) => boolean = allExist
): HelpDocIssueCode[] {
  return validateHelpDocs(files, imageExists).map((issue) => issue.code);
}

const PEER = helpDoc('peer-guide.md');

describe('validateHelpDocs', () => {
  it('accepts a valid set', () => {
    expect(validateHelpDocs([helpDoc('booking.md'), PEER], allExist)).toEqual([]);
  });

  it('missing_frontmatter', () => {
    expect(codes([{ filename: 'a.md', source: '## One\n\nx\n' }])).toEqual(['missing_frontmatter']);
  });

  it('invalid_frontmatter: names the failing field', () => {
    const issues = validateHelpDocs([helpDoc('a.md', { omit: ['summary'] })], allExist);
    expect(issues.map((issue) => issue.code)).toEqual(['invalid_frontmatter']);
    expect(issues[0]?.message).toContain('summary');
  });

  it('invalid_frontmatter: rejects unknown keys, bad dates and negative order', () => {
    expect(codes([helpDoc('a.md', { frontmatter: { extra: 'true' } })])).toEqual([
      'invalid_frontmatter',
    ]);
    expect(codes([helpDoc('a.md', { frontmatter: { updated: '17/10/2026' } })])).toEqual([
      'invalid_frontmatter',
    ]);
    expect(codes([helpDoc('a.md', { frontmatter: { order: '-1' } })])).toEqual([
      'invalid_frontmatter',
    ]);
  });

  it('invalid_frontmatter: rejects a repeated audience', () => {
    expect(codes([helpDoc('a.md', { frontmatter: { audience: '[client, client]' } })])).toContain(
      'invalid_frontmatter'
    );
  });

  it('invalid_slug', () => {
    expect(codes([helpDoc('Not_Kebab.md')])).toEqual(['invalid_slug']);
  });

  it('slug_mismatch', () => {
    expect(codes([helpDoc('a.md', { frontmatter: { slug: 'other' } })])).toEqual(['slug_mismatch']);
  });

  it('accepts a frontmatter slug that matches the filename', () => {
    expect(codes([helpDoc('a.md', { frontmatter: { slug: 'a' } })])).toEqual([]);
  });

  it('unknown_audience: names the bad value and does not double-report', () => {
    const issues = validateHelpDocs(
      [helpDoc('a.md', { frontmatter: { audience: '[client, agency]' } })],
      allExist
    );
    expect(issues.map((issue) => issue.code)).toEqual(['unknown_audience']);
    expect(issues[0]?.message).toContain('agency');
  });

  it('category_audience_mismatch: a category for a side not in audience', () => {
    expect(
      codes([helpDoc('a.md', { frontmatter: { category: '{ client: calls, expert: projects }' } })])
    ).toEqual(['category_audience_mismatch']);
  });

  it('category_audience_mismatch: an audience side with no category', () => {
    expect(
      codes([
        helpDoc('a.md', {
          frontmatter: { audience: '[client, expert]', category: '{ client: calls }' },
        }),
      ])
    ).toEqual(['category_audience_mismatch']);
  });

  it('unknown_category: an id that exists only on the other side', () => {
    expect(
      codes([helpDoc('a.md', { frontmatter: { category: '{ client: getting-paid }' } })])
    ).toEqual(['unknown_category']);
  });

  it('unknown_related: a slug with no file, published or not', () => {
    expect(codes([helpDoc('a.md', { frontmatter: { related: '[ghost]' } })])).toEqual([
      'unknown_related',
    ]);
    const draft = helpDoc('draft.md', { frontmatter: { published: 'false' } });
    expect(codes([helpDoc('a.md', { frontmatter: { related: '[draft]' } }), draft])).toEqual([]);
  });

  it('h1_in_body', () => {
    expect(codes([helpDoc('a.md', { body: '# Title\n\n## One\n\nx\n' })])).toEqual(['h1_in_body']);
  });

  it('inline_image', () => {
    expect(codes([helpDoc('a.md', { body: '## One\n\nSee ![s](a-s) here.\n' })])).toEqual([
      'inline_image',
    ]);
  });

  it('invalid_image_ref', () => {
    expect(codes([helpDoc('a.md', { body: '## One\n\n![s](Not_Kebab)\n' })])).toEqual([
      'invalid_image_ref',
    ]);
  });

  describe('missing_image (published only)', () => {
    const body = '## One\n\n![s](a-shot)\n\n![t](a-two)\n';

    it('reports both files when neither exists', () => {
      expect(codes([helpDoc('a.md', { body })], noneExist)).toEqual([
        'missing_image',
        'missing_image',
        'missing_image',
        'missing_image',
      ]);
    });

    it('reports a light-only gap', () => {
      const issues = validateHelpDocs(
        [helpDoc('a.md', { body: '## One\n\n![s](a-shot)\n' })],
        (publicPath) => publicPath.endsWith('-dark.png')
      );
      expect(issues.map((issue) => [issue.code, issue.message])).toEqual([
        ['missing_image', 'Image file /help/a/a-shot-light.png is missing.'],
      ]);
    });

    it('reports a dark-only gap', () => {
      const issues = validateHelpDocs(
        [helpDoc('a.md', { body: '## One\n\n![s](a-shot)\n' })],
        (publicPath) => publicPath.endsWith('-light.png')
      );
      expect(issues.map((issue) => issue.message)).toEqual([
        'Image file /help/a/a-shot-dark.png is missing.',
      ]);
    });

    it('does not check images of an unpublished guide', () => {
      const draft = helpDoc('a.md', { body, frontmatter: { published: 'false' } });
      expect(codes([draft], noneExist)).toEqual([]);
    });
  });
});
