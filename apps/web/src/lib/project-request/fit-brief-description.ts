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

/** The first `count` lines, minus any trailing blank lines and headings, rendered. */
function renderPrefix(lines: readonly string[], count: number): string | null {
  const prefix = lines.slice(0, count);
  dropDanglingTail(prefix);
  return prefix.length === 0 ? null : toHtml(prefix.join('\n'));
}

/**
 * The longest whole-line prefix of `lines` whose rendering fits `limit`, or `null` when not even
 * the first content line does.
 *
 * Binary search, not a line-at-a-time walk: a one-word-per-line output (which a prompt injection
 * in an uploaded document could produce) would otherwise cost a full convert + sanitise per line
 * — around a thousand passes over up to 8 KB inside a Server Action. The search is exact because
 * the converter renders every line independently (no fences, tables or multi-line inline
 * markup), so the visible length never shrinks as more lines are kept.
 *
 * ⚠ THE SEARCH STARTS AFTER THE LEADING HEADINGS AND BLANKS. A prefix with no content line renders
 * to nothing (`null`), which reads as "doesn't fit" although nothing overflowed — false, then
 * true, then false, which a binary search cannot handle. Every case brief opens with
 * `## Problem`, so this is the common shape, not an edge. Past those lines the check is monotone;
 * the answer is still re-measured, and the walk resumes downward from it should that ever stop
 * holding.
 */
function longestFittingPrefix(lines: readonly string[], limit: number): string | null {
  const fitting = (count: number): string | null => {
    const html = renderPrefix(lines, count);
    return html !== null && visibleLength(html) <= limit ? html : null;
  };
  const leading = lines.findIndex(isContentLine);
  if (leading === -1) return null;
  let lo = leading;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitting(mid) === null) hi = mid - 1;
    else lo = mid;
  }
  for (let count = lo; count > leading; count -= 1) {
    const html = fitting(count);
    if (html !== null) return html;
  }
  return null;
}

/**
 * Fit a generated brief's markdown description to the form's visible-text cap, so a draft can
 * never prefill the review step already over the limit.
 *
 * The prompt asks for well under the cap; this is the guarantee for when the model overshoots.
 * The longest run of whole leading lines (bullets, paragraph lines) that fits is kept, minus any
 * heading left with nothing under it — the brief keeps its opening, which carries the problem and
 * the core scope. Only when no whole line fits (one long paragraph) is a line cut, at a word
 * boundary, with an ellipsis; if even that cannot fit, `html` is `''` and the caller must refuse
 * the draft rather than deliver an empty description.
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

  const all = markdown.split('\n');
  const kept = longestFittingPrefix(all, limit);
  if (kept !== null) {
    return { html: kept, originalTextLength, trimmed: true };
  }

  // No whole line fits: the first content line is itself over the limit. Keep the headings
  // above it and cut that line.
  const firstContent = all.findIndex(isContentLine);
  const head = firstContent > 0 ? all.slice(0, firstContent) : [];
  const cut = cutLineToFit(head, all[firstContent] ?? '', limit);
  return {
    html: cut === null ? '' : toHtml([...head, cut].join('\n')),
    originalTextLength,
    trimmed: true,
  };
}
