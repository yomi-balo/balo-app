import 'server-only';

import sanitizeHtml from 'sanitize-html';
import { isDescriptionEmpty, toRichTextHtml } from '@/components/balo/rich-text/plain-text';
import { PROJECT_HTML_ALLOWED_TAGS } from './allowed-tags';

/**
 * The brief's allow-list WITHOUT `a`. Responsibilities render on the public expert profile, and a
 * clickable link there is an off-platform channel ("book me directly at …"), so a link is reduced
 * to its text. The `minimal` editor variant offers no Link control to match.
 */
const RESPONSIBILITIES_ALLOWED_TAGS = PROJECT_HTML_ALLOWED_TAGS.filter((tag) => tag !== 'a');

/**
 * The SECURITY BOUNDARY for a work-history entry's rich-text responsibilities — run before every
 * persist (apply draft save, expert settings save) and again before any `dangerouslySetInnerHTML`
 * render. Never trust client HTML.
 *
 * Legacy plain text is converted to escaped paragraphs first, so a value of either format comes
 * out as safe HTML. Disallowed tags are dropped with their text kept (scripts and styles lose
 * their content too). An effectively empty value (the editor's bare `<p></p>`) returns `''`,
 * which the repository stores as NULL.
 */
export function sanitizeResponsibilitiesHtml(value: string | null | undefined): string {
  const html = toRichTextHtml(value);
  if (html === '' || isDescriptionEmpty(html)) return '';
  const safe = sanitizeHtml(html, {
    allowedTags: RESPONSIBILITIES_ALLOWED_TAGS,
    allowedAttributes: {},
  });
  return isDescriptionEmpty(safe) ? '' : safe;
}
