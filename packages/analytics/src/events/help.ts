/**
 * BAL-597 — the public help centre's CLIENT event family (`/help`, `/help/[slug]`).
 *
 * ⚠ `feedback_submitted.comment` is the FIRST free-text property sent to PostHog. It is sent only
 * when `helpful` is false and the trimmed comment is non-empty, and is capped at
 * `HELP_FEEDBACK_COMMENT_MAX` characters. `has_comment` mirrors whether `comment` is present.
 *
 * ⚠ PII: the comment is free text typed by a person and is stored against their identified
 * `distinct_id` (the PostHog identity is the user once signed in), so it can contain names, emails
 * or anything else they write. Any user-erasure path must therefore reach PostHog to delete that
 * person's events, not only Balo's own tables.
 */

/** Which side of the marketplace a guide is written for. Canonical order: client first. */
export const HELP_AUDIENCES = ['client', 'expert'] as const;
export type HelpAudience = (typeof HELP_AUDIENCES)[number];

/** How the reader arrived at a guide. `external` covers a direct link, search or any unknown `src`. */
export const HELP_ARTICLE_SOURCES = ['index', 'related', 'product', 'external'] as const;
export type HelpArticleSource = (typeof HELP_ARTICLE_SOURCES)[number];

/** Maximum characters of the feedback comment sent to PostHog. */
export const HELP_FEEDBACK_COMMENT_MAX = 1000;

export const HELP_EVENTS = {
  /** The help centre list page was viewed. Emitted once per page mount. */
  INDEX_VIEWED: 'help_index_viewed',
  /** The reader switched the client/expert tab on the list page. */
  AUDIENCE_SWITCHED: 'help_audience_switched',
  /** A guide page was viewed. Emitted once per guide. */
  ARTICLE_VIEWED: 'help_article_viewed',
  /** The reader jumped to a section through the rail or the mobile jump list. */
  SECTION_JUMPED: 'help_section_jumped',
  /** The reader finished the "was this helpful" flow. Emitted once, on Yes, Send or Skip. */
  FEEDBACK_SUBMITTED: 'help_feedback_submitted',
} as const;

export interface HelpEventMap {
  [HELP_EVENTS.INDEX_VIEWED]: { audience: HelpAudience; signed_in: boolean };
  [HELP_EVENTS.AUDIENCE_SWITCHED]: { from: HelpAudience; to: HelpAudience };
  [HELP_EVENTS.ARTICLE_VIEWED]: { slug: string; audience: HelpAudience; source: HelpArticleSource };
  [HELP_EVENTS.SECTION_JUMPED]: {
    slug: string;
    /** 1-based section number. */
    section: number;
  };
  [HELP_EVENTS.FEEDBACK_SUBMITTED]: {
    slug: string;
    helpful: boolean;
    has_comment: boolean;
    comment?: string;
  };
}
