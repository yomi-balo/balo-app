import 'server-only';

import { isDescriptionEmpty, toRichTextHtml } from '@/components/balo/rich-text/plain-text';
import { sanitizeProjectHtml } from './project-html';

/**
 * The SECURITY BOUNDARY for a work-history entry's rich-text responsibilities — run before every
 * persist (apply draft save, expert settings save) and again before any `dangerouslySetInnerHTML`
 * render. Never trust client HTML.
 *
 * Reuses the brief's allow-list (`sanitizeProjectHtml`): the `light` editor emits a subset of it.
 * Legacy plain text is converted to escaped paragraphs first, so a value of either format comes
 * out as safe HTML. An effectively empty value (the editor's bare `<p></p>`) returns `''`, which
 * the repository stores as NULL.
 */
export function sanitizeResponsibilitiesHtml(value: string | null | undefined): string {
  const html = toRichTextHtml(value);
  if (html === '' || isDescriptionEmpty(html)) return '';
  const safe = sanitizeProjectHtml(html);
  return isDescriptionEmpty(safe) ? '' : safe;
}
