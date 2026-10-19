import 'server-only';

import { htmlToPlainText } from '@balo/shared/notifications';
import { MAX_PROJECT_DESCRIPTION_TEXT_LENGTH } from '@balo/shared/project-requests';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { markdownToProjectHtml } from './markdown-to-project-html';

export interface FittedBriefDescription {
  /** Converted THEN sanitised (the D4 order), and within the limit. */
  readonly html: string;
  /** Visible-text length of the model's full description, before any trim. */
  readonly originalTextLength: number;
  readonly trimmed: boolean;
}

const HEADING_LINE = /^#{2,3} /;
const ELLIPSIS = '…';

function toHtml(markdown: string): string {
  return sanitizeProjectHtml(markdownToProjectHtml(markdown));
}

/** The form's own measure — `validateDescription` counts exactly this. */
function visibleLength(html: string): number {
  return htmlToPlainText(html).length;
}

function isContentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && !HEADING_LINE.test(trimmed);
}

/** Drop trailing blank lines and headings: a heading with nothing under it is not content. */
function dropDanglingTail(lines: string[]): void {
  while (lines.length > 0 && !isContentLine(lines.at(-1) ?? '')) {
    lines.pop();
  }
}

/**
 * The longest word-boundary prefix of `line`, ending in an ellipsis, that fits after `head`.
 * Binary search on the cut point; the result is re-measured because inline markup makes "fits"
 * only roughly monotone in the prefix length.
 */
function cutLineToFit(head: readonly string[], line: string, limit: number): string | null {
  const measure = (cut: string): number => visibleLength(toHtml([...head, cut].join('\n')));
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${line.slice(0, mid).trimEnd()}${ELLIPSIS}`) <= limit) lo = mid;
    else hi = mid - 1;
  }
  const prefix = line.slice(0, lo);
  const lastSpace = prefix.lastIndexOf(' ');
  const cut = (lastSpace > 0 ? prefix.slice(0, lastSpace) : prefix).trimEnd();
  if (cut === '') return null;
  const candidate = `${cut}${ELLIPSIS}`;
  return measure(candidate) <= limit ? candidate : null;
}

/**
 * Fit a generated brief's markdown description to the form's visible-text cap, so a draft can
 * never prefill the review step already over the limit.
 *
 * The prompt asks for well under the cap; this is the guarantee for when the model overshoots.
 * Whole trailing lines (bullets, paragraph lines) are dropped until the rest fits, along with any
 * heading left with nothing under it — the brief keeps its opening, which carries the problem and
 * the core scope. Only when no whole line fits (one long paragraph) is a line cut, at a word
 * boundary, with an ellipsis.
 *
 * Measured on the converted, sanitised HTML with the same `htmlToPlainText` the form validates
 * with, so "fits here" means "submittable there".
 */
export function fitBriefDescription(
  markdown: string,
  limit: number = MAX_PROJECT_DESCRIPTION_TEXT_LENGTH
): FittedBriefDescription {
  const html = toHtml(markdown);
  const originalTextLength = visibleLength(html);
  if (originalTextLength <= limit) {
    return { html, originalTextLength, trimmed: false };
  }

  const lines = markdown.split('\n');
  while (lines.length > 0) {
    lines.pop();
    dropDanglingTail(lines);
    if (lines.length === 0) break;
    const candidate = toHtml(lines.join('\n'));
    if (visibleLength(candidate) <= limit) {
      return { html: candidate, originalTextLength, trimmed: true };
    }
  }

  // No whole line fits: the first content line is itself over the limit. Keep the headings
  // above it and cut that line.
  const all = markdown.split('\n');
  const firstContent = all.findIndex(isContentLine);
  const head = firstContent > 0 ? all.slice(0, firstContent) : [];
  const cut = cutLineToFit(head, all[firstContent] ?? '', limit);
  return {
    html: cut === null ? '' : toHtml([...head, cut].join('\n')),
    originalTextLength,
    trimmed: true,
  };
}
