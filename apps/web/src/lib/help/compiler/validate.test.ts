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

  describe('unpublished_link', () => {
    const linking = (published: string) =>
      helpDoc('a.md', {
        frontmatter: { published },
        body: 'See [Draft](/help/draft) and [Peer](/help/peer-guide#step-2).\n\n## One\n\nSee [Draft](/help/draft).\n',
      });
    const draft = helpDoc('draft.md', { frontmatter: { published: 'false' } });

    it('flags each unpublished target once in a published guide', () => {
      const issues = validateHelpDocs([linking('true'), draft, PEER], allExist);
      expect(issues.map((issue) => [issue.code, issue.message])).toEqual([
        ['unpublished_link', 'The link to /help/draft goes nowhere: that guide is not published.'],
      ]);
    });

    it('flags a link to a guide with no file', () => {
      expect(codes([linking('true'), PEER])).toEqual(['unpublished_link']);
    });

    it('does not check links in an unpublished guide', () => {
      expect(codes([linking('false'), draft, PEER])).toEqual([]);
    });
  });

  describe('support_section', () => {
    it.each(['Questions?', 'questions', 'Need help?', 'Still stuck?', 'Contact us'])(
      'flags a "%s" section, published or not',
      (title) => {
        const body = `Intro.\n\n## ${title}\n\nReach us any time.\n`;
        expect(codes([helpDoc('a.md', { body })])).toEqual(['support_section']);
        expect(codes([helpDoc('a.md', { body, frontmatter: { published: 'false' } })])).toEqual([
          'support_section',
        ]);
      }
    );

    it('allows a support address inside a step', () => {
      const body =
        'Intro.\n\n## Apply again\n\nWrite to [support@getbalo.com](mailto:support@getbalo.com).\n';
      expect(codes([helpDoc('a.md', { body })])).toEqual([]);
    });
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

  describe('unsupported_markdown', () => {
    it.each([
      ['table', '## One\n\n| a |\n| - |\n| b |\n', 'table'],
      ['fenced code', '## One\n\n```\ncode\n```\n', 'code'],
      ['indented code', '## One\n\n    indented\n', 'code'],
      ['hr', '## One\n\nText.\n\n---\n\nMore.\n', 'hr'],
      ['block html', '## One\n\n<div>raw</div>\n', 'html'],
      ['inline html', '## One\n\nSome <b>bold</b>.\n', 'html'],
      ['inline html in a ## heading', '## One <span>x</span>\n\ntext\n', 'html'],
      ['heading level 5', '## One\n\n##### Deep\n', 'heading level 5'],
      ['heading level 6', '## One\n\n###### Deeper\n', 'heading level 6'],
    ])('flags %s and names it', (_name, body, label) => {
      const issues = validateHelpDocs([helpDoc('a.md', { body })], allExist);
      expect(issues.map((issue) => issue.code)).toEqual(['unsupported_markdown']);
      expect(issues[0]?.message).toContain(label);
    });

    it('accepts h3, h4, lists, links, emphasis and inline code', () => {
      const body = '## One\n\n### Sub\n\n#### Subsub\n\n- **a** and *b*\n- `c` [d](/e)\n';
      expect(codes([helpDoc('a.md', { body })])).toEqual([]);
    });
  });

  describe('forbidden_copy', () => {
    it('flags a forbidden term in the title, the summary, a section title and the body', () => {
      expect(codes([helpDoc('a.md', { frontmatter: { title: '"Your payout"' } })])).toEqual([
        'forbidden_copy',
      ]);
      expect(codes([helpDoc('a.md', { frontmatter: { summary: '"Our Commission"' } })])).toEqual([
        'forbidden_copy',
      ]);
      expect(codes([helpDoc('a.md', { body: '## Your earnings\n\nx\n' })])).toEqual([
        'forbidden_copy',
      ]);
      expect(codes([helpDoc('a.md', { body: '## One\n\nWe keep a **platform fee**.\n' })])).toEqual(
        ['forbidden_copy']
      );
    });

    it('allows payout and earnings talk in an expert-only guide', () => {
      const expert = { audience: '[expert]', category: '{ expert: projects }' };
      const body = '## One\n\nYour payout and earnings.\n';
      expect(codes([helpDoc('a.md', { frontmatter: expert, body })])).toEqual([]);
    });

    it('still bans fee and margin talk in an expert-only guide', () => {
      const expert = { audience: '[expert]', category: '{ expert: projects }' };
      const body = '## One\n\nOur margin.\n';
      expect(codes([helpDoc('a.md', { frontmatter: expert, body })])).toEqual(['forbidden_copy']);
    });

    it('bans payout talk in a client guide and in a dual guide', () => {
      const body = '## One\n\nYour payout.\n';
      expect(codes([helpDoc('a.md', { body })])).toEqual(['forbidden_copy']);
      const dual = {
        audience: '[client, expert]',
        category: '{ client: calls, expert: projects }',
      };
      expect(codes([helpDoc('a.md', { frontmatter: dual, body })])).toEqual(['forbidden_copy']);
    });

    it('applies to unpublished guides too', () => {
      const draft = helpDoc('a.md', {
        frontmatter: { published: 'false' },
        body: '## One\n\nOur margin.\n',
      });
      expect(codes([draft])).toEqual(['forbidden_copy']);
    });

    it('does not read tag names or attributes as text', () => {
      const body = '## One\n\n[go](/settings/payouts) now.\n';
      expect(codes([helpDoc('a.md', { body })])).toEqual([]);
    });
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
