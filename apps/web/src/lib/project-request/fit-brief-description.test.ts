import { describe, it, expect, vi } from 'vitest';
import { htmlToPlainText } from '@balo/shared/notifications';
import { MAX_PROJECT_DESCRIPTION_TEXT_LENGTH } from '@balo/shared/project-requests';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';

// A pass-through spy, so the render count of the trim can be pinned.
vi.mock('@/lib/sanitize/project-html', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sanitize/project-html')>();
  return { ...actual, sanitizeProjectHtml: vi.fn(actual.sanitizeProjectHtml) };
});
import { validateDescription } from '@/components/balo/rich-text/plain-text';
import { markdownToProjectHtml } from './markdown-to-project-html';
import { fitBriefDescription } from './fit-brief-description';

const visible = (html: string): number => htmlToPlainText(html).length;

/** A brief shaped like real model output: headed sections of bullet points. */
function briefOf(sections: number, bulletsPerSection: number): string {
  const lines: string[] = [
    'A short opening paragraph that states the problem in one sentence.',
    '',
  ];
  for (let s = 1; s <= sections; s += 1) {
    lines.push(`## Section ${s}`);
    for (let b = 1; b <= bulletsPerSection; b += 1) {
      lines.push(
        `- **Item ${s}.${b}** — the client needs this capability delivered and tested end to end.`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

describe('fitBriefDescription', () => {
  it('passes a description within the limit through untouched, converted then sanitised', () => {
    const markdown = 'See [the brief](https://example.com) and **bold** text.';

    const fitted = fitBriefDescription(markdown);

    expect(fitted.trimmed).toBe(false);
    expect(fitted.html).toBe(sanitizeProjectHtml(markdownToProjectHtml(markdown)));
    expect(fitted.originalTextLength).toBe(visible(fitted.html));
  });

  it('defaults to the form cap — 4,000 visible characters', () => {
    expect(MAX_PROJECT_DESCRIPTION_TEXT_LENGTH).toBe(4000);
    const markdown = briefOf(6, 10);
    expect(visible(markdownToProjectHtml(markdown))).toBeGreaterThan(4000);

    const fitted = fitBriefDescription(markdown);

    expect(fitted.trimmed).toBe(true);
    expect(visible(fitted.html)).toBeLessThanOrEqual(4000);
  });

  it('⚠ an over-limit brief comes out SUBMITTABLE by the form’s own validator', () => {
    const markdown = briefOf(6, 10);
    expect(
      validateDescription(sanitizeProjectHtml(markdownToProjectHtml(markdown)))
    ).not.toBeNull();

    expect(validateDescription(fitBriefDescription(markdown).html)).toBeNull();
  });

  it('drops whole trailing lines, keeping the opening and leaving no bullet cut mid-sentence', () => {
    const markdown = briefOf(3, 4);
    const limit = Math.floor(visible(markdownToProjectHtml(markdown)) * 0.6);

    const fitted = fitBriefDescription(markdown, limit);

    expect(visible(fitted.html)).toBeLessThanOrEqual(limit);
    expect(fitted.html).toContain('A short opening paragraph');
    expect(fitted.html).toContain('<h2>Section 1</h2>');
    expect(fitted.html).not.toContain('…');
    expect(htmlToPlainText(fitted.html)).toMatch(/end to end\.$/);
  });

  it('drops no more than it must — the room left is less than one more bullet and its heading', () => {
    const markdown = briefOf(3, 4);
    const limit = Math.floor(visible(markdownToProjectHtml(markdown)) * 0.6);

    const fitted = fitBriefDescription(markdown, limit);

    // One bullet is ~90 visible characters; a section heading adds ~10.
    expect(limit - visible(fitted.html)).toBeLessThan(110);
  });

  it('drops a heading left with nothing under it', () => {
    const markdown = [
      'Opening paragraph about the work.',
      '',
      '## Kept heading',
      '- a short bullet',
      '',
      '## Orphaned heading',
      `- ${'x'.repeat(200)}`,
    ].join('\n');

    const fitted = fitBriefDescription(markdown, 80);

    expect(fitted.html).not.toContain('Orphaned heading');
    expect(fitted.html).toContain('a short bullet');
  });

  it('cuts one long paragraph at a word boundary with an ellipsis when no whole line fits', () => {
    const markdown = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');

    const fitted = fitBriefDescription(markdown, 500);
    const text = htmlToPlainText(fitted.html);

    expect(fitted.trimmed).toBe(true);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.length).toBeGreaterThan(480);
    expect(text).toMatch(/^word0 word1 .* word\d+…$/);
  });

  it('keeps the headings above an over-long first paragraph', () => {
    const markdown = ['## Problem', Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ')].join(
      '\n'
    );

    const fitted = fitBriefDescription(markdown, 300);

    expect(fitted.html.startsWith('<h2>Problem</h2>')).toBe(true);
    expect(visible(fitted.html)).toBeLessThanOrEqual(300);
    expect(htmlToPlainText(fitted.html)).toMatch(/…$/);
  });

  it('reports the untrimmed visible length for the log', () => {
    const markdown = briefOf(6, 10);

    const fitted = fitBriefDescription(markdown);

    expect(fitted.originalTextLength).toBe(visible(markdownToProjectHtml(markdown)));
  });

  it.each([1500, 3000, 4000, 4001, 4600, 6000, 7900])(
    'never exceeds the cap for a %i-character brief',
    (target) => {
      let markdown = '';
      let n = 0;
      while (markdown.length < target) {
        n += 1;
        markdown +=
          n % 9 === 0 ? `\n## Heading ${n}\n` : `- bullet ${n} with **some** _inline_ text\n`;
      }

      expect(visible(fitBriefDescription(markdown).html)).toBeLessThanOrEqual(4000);
    }
  );

  it('⚠ one word per line costs a logarithmic number of renders, not one per line', () => {
    const markdown = Array.from({ length: 3000 }, (_, i) => `word${i}`).join('\n');
    vi.mocked(sanitizeProjectHtml).mockClear();

    const fitted = fitBriefDescription(markdown);

    expect(visible(fitted.html)).toBeLessThanOrEqual(4000);
    expect(visible(fitted.html)).toBeGreaterThan(3990);
    // 1 full render + ~log2(3000) ≈ 12 search renders + 1 final.
    expect(vi.mocked(sanitizeProjectHtml).mock.calls.length).toBeLessThan(20);
  });
});
