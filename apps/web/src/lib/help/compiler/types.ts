export interface HelpSourceFile {
  /** Including the `.md` extension. */
  readonly filename: string;
  readonly source: string;
}

export type HelpDocIssueCode =
  | 'missing_frontmatter'
  | 'invalid_frontmatter'
  | 'invalid_slug'
  | 'slug_mismatch'
  | 'unknown_audience'
  | 'category_audience_mismatch'
  | 'unknown_category'
  | 'unknown_related'
  | 'h1_in_body'
  | 'inline_image'
  | 'invalid_image_ref'
  | 'missing_image';

export interface HelpDocIssue {
  readonly file: string;
  readonly code: HelpDocIssueCode;
  readonly message: string;
}
