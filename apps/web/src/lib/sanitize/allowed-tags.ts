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

/**
 * The WIDENED allow-list for the FULL proposal-overview editor (A6.2 / BAL-288).
 *
 * A superset of {@link PROJECT_HTML_ALLOWED_TAGS} — the overview is a richer
 * authoring surface than the brief, so it additionally permits `blockquote`
 * (callout/quote blocks) and `hr` (section breaks) per decided Q3. The brief
 * list stays untouched (milestone light-text and the project brief keep reusing
 * it via `sanitizeProjectHtml`).
 *
 * Like the brief list, this is intentionally CLIENT-SAFE (no `server-only`, no
 * Node deps) so it can be the SINGLE SOURCE shared by BOTH the full overview
 * editor's TipTap config AND the server sanitiser (`sanitizeProposalOverviewHtml`)
 * — keeping what the editor can produce in lockstep with what the server keeps.
 * The server sanitiser remains the security boundary.
 */
export const PROPOSAL_OVERVIEW_ALLOWED_TAGS = [
  ...PROJECT_HTML_ALLOWED_TAGS,
  'blockquote',
  'hr',
] as const;

export type ProposalOverviewAllowedTag = (typeof PROPOSAL_OVERVIEW_ALLOWED_TAGS)[number];
