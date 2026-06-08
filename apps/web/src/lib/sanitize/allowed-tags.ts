/**
 * The single source of truth for the project-brief rich-text allow-list (ADR-1022).
 *
 * This file is intentionally CLIENT-SAFE (no `server-only`, no Node deps) so it can
 * be imported by BOTH the server sanitiser (`project-html.ts`) AND the client
 * rich-text editor config — keeping what the editor can produce in lockstep with
 * what the server keeps. The server sanitiser is the security boundary; the editor
 * restriction is UX only.
 */
export const PROJECT_HTML_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'a',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
] as const;

export type ProjectHtmlAllowedTag = (typeof PROJECT_HTML_ALLOWED_TAGS)[number];
