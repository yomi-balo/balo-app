/**
 * Descendant-variant styles for rendered rich-text content (editor + viewer).
 * This app ships no `@tailwindcss/typography` plugin, and Tailwind preflight
 * flattens headings + strips list markers, so the locked ADR-1022 / design §2.3
 * formats are restored explicitly: H2 = base/semibold, H3 = sm/semibold,
 * disc / decimal lists with indent, primary underlined links. Shared so the
 * editor and the read-only viewer render identically.
 */
export const RICH_TEXT_CONTENT_CLASS =
  '[&_p]:my-2 [&_strong]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2';

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
}

export interface RichTextViewerProps {
  /** HTML to render read-only. Re-parsed through the locked Tiptap schema, so
   *  any tag/attribute outside the allow-list is dropped on parse. */
  value: string;
  className?: string;
}
