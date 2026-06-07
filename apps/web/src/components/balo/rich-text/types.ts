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
