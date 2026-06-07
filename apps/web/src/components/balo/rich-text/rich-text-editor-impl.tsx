'use client';

import { useCallback, useEffect, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Link as LinkIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { normalizeLinkUrl } from './plain-text';
import type { RichTextEditorProps } from './types';

/**
 * StarterKit trimmed to the ADR-1022 locked set. We DISABLE everything outside
 * the allow-list (bold, italic, link, h2, h3, bullet/ordered list) so the editor
 * can never produce a tag the server sanitiser would strip — the editor
 * restriction and the sanitiser stay in lockstep (allow-list lives in
 * `lib/sanitize/allowed-tags.ts`; this is its UI projection).
 */
function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      // Locked OUT — these have no toolbar control and aren't in the allow-list.
      blockquote: false,
      codeBlock: false,
      code: false,
      horizontalRule: false,
      strike: false,
      // Tiptap v3 StarterKit bundles a link extension; disable it so our
      // configured Link extension (below) is the single source.
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    Placeholder.configure({ placeholder }),
  ];
}

interface ToolbarButtonProps {
  label: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}

function ToolbarButton({
  label,
  title,
  active,
  disabled,
  onClick,
  icon,
}: Readonly<ToolbarButtonProps>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title}
      // Prevent the editor losing selection when the toolbar is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'focus-visible:ring-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {icon}
    </button>
  );
}

interface LinkPopoverProps {
  editor: Editor;
}

function LinkPopover({ editor }: Readonly<LinkPopoverProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const isActive = editor.isActive('link');
  // No selection AND not on a link → nothing to link.
  const hasSelection = !editor.state.selection.empty;
  const disabled = !hasSelection && !isActive;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        const existing = (editor.getAttributes('link').href as string | undefined) ?? '';
        setUrl(existing);
      }
      setOpen(next);
    },
    [editor]
  );

  const apply = useCallback(() => {
    const normalized = normalizeLinkUrl(url);
    if (normalized === null) {
      toast.error('Links must start with http:// or https://');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run();
    setOpen(false);
  }, [editor, url]);

  const remove = useCallback(() => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setOpen(false);
  }, [editor]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Insert link"
          aria-pressed={isActive}
          title="Link"
          onMouseDown={(e) => e.preventDefault()}
          disabled={disabled}
          className={cn(
            'focus-visible:ring-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none',
            isActive
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            disabled && 'pointer-events-none opacity-40'
          )}
        >
          <LinkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] max-w-[260px] space-y-2.5 p-3">
        <label htmlFor="rte-link-url" className="text-foreground block text-xs font-semibold">
          Link URL
        </label>
        <input
          id="rte-link-url"
          type="url"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
          }}
          placeholder="https://…"
          className="border-border bg-card focus-visible:border-ring focus-visible:ring-ring/30 text-foreground placeholder:text-muted-foreground h-9 w-full rounded-lg border px-3 text-sm transition-shadow focus-visible:ring-[3px] focus-visible:outline-none"
        />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={apply} className="flex-1">
            Add link
          </Button>
          {isActive && (
            <Button type="button" size="sm" variant="ghost" onClick={remove}>
              Remove
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Heavy Tiptap editor — code-split behind a dynamic import (see the
 * `rich-text-editor.tsx` wrapper) so it never ships in the public profile's
 * initial bundle. Emits sanitisable HTML on every change; the parent debounces
 * it into autosave. Toolbar order is locked (design §2.3): Bold, Italic | H2,
 * H3 | Bullet, Numbered | Link.
 */
export default function RichTextEditorImpl({
  value,
  onChange,
  placeholder,
  ariaLabel = 'Project description',
  className,
}: Readonly<RichTextEditorProps>): React.JSX.Element {
  const editor = useEditor({
    extensions: buildExtensions(placeholder ?? ''),
    content: value,
    // Avoid SSR hydration mismatch (we already gate with ssr:false, but Tiptap
    // recommends this explicitly).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        role: 'textbox',
        'aria-multiline': 'true',
        class:
          'prose-sm text-foreground min-h-[180px] max-h-[340px] overflow-y-auto px-3.5 py-3 text-sm leading-relaxed focus:outline-none',
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    },
  });

  // Keep the editor in sync if the value is reset externally (e.g. clearDraft).
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
    // Only react to external value resets, not our own onUpdate echoes.
  }, [value, editor]);

  if (!editor) {
    return (
      <div className={cn('border-border bg-card h-[226px] rounded-[11px] border', className)} />
    );
  }

  return (
    <div
      className={cn(
        'border-border bg-card focus-within:border-ring focus-within:ring-ring/30 overflow-hidden rounded-[11px] border transition-shadow focus-within:ring-[3px]',
        className
      )}
    >
      <div className="border-border bg-muted/40 sticky top-0 z-10 flex h-11 items-center gap-1 overflow-x-auto border-b px-2">
        <ToolbarButton
          label="Bold"
          title="Bold (⌘B)"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          icon={<Bold className="h-4 w-4" aria-hidden="true" />}
        />
        <ToolbarButton
          label="Italic"
          title="Italic (⌘I)"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          icon={<Italic className="h-4 w-4" aria-hidden="true" />}
        />
        <Separator orientation="vertical" className="mx-0.5 !h-5" />
        <ToolbarButton
          label="Heading 2"
          title="Heading 2"
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          icon={<Heading2 className="h-4 w-4" aria-hidden="true" />}
        />
        <ToolbarButton
          label="Heading 3"
          title="Heading 3"
          active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          icon={<Heading3 className="h-4 w-4" aria-hidden="true" />}
        />
        <Separator orientation="vertical" className="mx-0.5 !h-5" />
        <ToolbarButton
          label="Bullet list"
          title="Bullet list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          icon={<List className="h-4 w-4" aria-hidden="true" />}
        />
        <ToolbarButton
          label="Numbered list"
          title="Numbered list"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          icon={<ListOrdered className="h-4 w-4" aria-hidden="true" />}
        />
        <Separator orientation="vertical" className="mx-0.5 !h-5" />
        <LinkPopover editor={editor} />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
