/**
 * Descendant-variant styles for rendered rich-text content (editor + viewer).
 * This app ships no `@tailwindcss/typography` plugin, and Tailwind preflight
 * flattens headings + strips list markers, so the locked ADR-1022 / design §2.3
 * formats are restored explicitly: H2 = base/semibold, H3 = sm/semibold,
 * disc / decimal lists with indent, primary underlined links, plus the widened
 * proposal-overview blocks — `blockquote` (left border + muted text) and `hr`
 * (border rule). Shared so the editor and the read-only viewer render identically.
 */
export const RICH_TEXT_CONTENT_CLASS =
  '[&_p]:my-2 [&_strong]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic [&_hr]:border-border [&_hr]:my-3 [&_hr]:border-t';

/**
 * Editor surface variant. Each variant projects a different slice of the
 * sanitiser allow-list onto the toolbar/contextual controls:
 *  - `standard` — the locked ADR-1022 brief editor (default; persistent toolbar,
 *    unchanged behaviour so existing call-sites are untouched).
 *  - `full` — the proposal-overview editor: NO persistent toolbar; contextual
 *    selection bubble menu + `/` slash command, optional collapse-on-blur. Its
 *    enabled node/mark set is the widened `PROPOSAL_OVERVIEW_ALLOWED_TAGS`.
 *  - `light` — the milestone-description editor: a minimal persistent mini-toolbar
 *    (Bold, Italic, bullet list, Link only — no headings/ordered list).
 */
export type RichTextEditorVariant = 'standard' | 'full' | 'light';

export interface RichTextEditorProps {
  /** Current HTML value (from the draft). */
  value: string;
  /** Fires the new HTML on every change (parent debounces into autosave). */
  onChange: (html: string) => void;
  /** Placeholder text shown in the empty editor. */
  placeholder?: string;
  /** Accessible name for the editable region. Defaults to "Project description". */
  ariaLabel?: string;
  className?: string;
  /** Editor surface variant. Defaults to `'standard'` (current behaviour). */
  variant?: RichTextEditorVariant;
  /**
   * `full` variant only: when true, the editor collapses to ~3 lines on blur if
   * the content overflows, with a "Show full overview" affordance to re-expand.
   * Ignored by `standard`/`light`. Defaults to `false`.
   */
  collapseOnBlur?: boolean;
}

export interface RichTextViewerProps {
  /** HTML to render read-only. Re-parsed through the locked Tiptap schema, so
   *  any tag/attribute outside the allow-list is dropped on parse. */
  value: string;
  className?: string;
}
