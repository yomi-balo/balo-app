import 'server-only';

import sanitizeHtml from 'sanitize-html';
import { isDescriptionEmpty, toRichTextHtml } from '@/components/balo/rich-text/plain-text';
import { WORK_HISTORY_HTML_ALLOWED_TAGS } from './allowed-tags';

/**
 * The SECURITY BOUNDARY for a work-history entry's rich-text responsibilities — run before every
 * persist (apply draft save, expert settings save) and again before any `dangerouslySetInnerHTML`
 * render. Never trust client HTML.
 *
 * Allows exactly `WORK_HISTORY_HTML_ALLOWED_TAGS` — what the `minimal` editor produces — so a
 * crafted request can plant neither a heading nor a link on a public profile; a link is reduced
 * to its text, a heading becomes a paragraph and a numbered list a bullet list. Legacy plain text
 * is converted to escaped paragraphs first, so a value of either format comes out as safe HTML.
 * Other disallowed tags are dropped with their text kept (scripts and styles lose their content
 * too). An effectively empty value (the editor's bare `<p></p>`) returns `''`, which the
 * repository stores as NULL.
 */
export function sanitizeResponsibilitiesHtml(value: string | null | undefined): string {
  const html = toRichTextHtml(value);
  if (html === '' || isDescriptionEmpty(html)) return '';
  const safe = sanitizeHtml(html, {
    allowedTags: [...WORK_HISTORY_HTML_ALLOWED_TAGS],
    allowedAttributes: {},
    // Keep the STRUCTURE of the two block shapes the narrow list excludes, rather than leaving
    // orphan `<li>`s or running a heading's text into the next block.
    transformTags: {
      h1: 'p',
      h2: 'p',
      h3: 'p',
      h4: 'p',
      h5: 'p',
      h6: 'p',
      ol: 'ul',
    },
  });
  return isDescriptionEmpty(safe) ? '' : safe;
}
