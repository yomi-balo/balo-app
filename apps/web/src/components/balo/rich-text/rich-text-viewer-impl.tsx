'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { cn } from '@/lib/utils';
import { RICH_TEXT_CONTENT_CLASS, type RichTextViewerProps } from './types';

/**
 * Read-only render of a brief's HTML for the review step. Uses Tiptap in
 * non-editable mode with the SAME locked schema as the editor, so the HTML is
 * re-parsed through the allow-list (any script/style/unknown tag or attribute is
 * dropped on parse) — no `dangerouslySetInnerHTML` of client HTML. The server
 * sanitiser remains the persisted-storage security boundary.
 */
export default function RichTextViewerImpl({
  value,
  className,
}: Readonly<RichTextViewerProps>): React.JSX.Element {
  const editor = useEditor({
    editable: false,
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        strike: false,
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: `text-foreground text-sm leading-relaxed focus:outline-none ${RICH_TEXT_CONTENT_CLASS}`,
      },
    },
  });

  if (!editor) {
    return <div className={cn('text-muted-foreground text-sm', className)} />;
  }

  return <EditorContent editor={editor} className={className} />;
}
