'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu';
import type { Editor } from '@tiptap/react';
import { Bold, Italic, Heading2, Link as LinkIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { normalizeLinkUrl } from './plain-text';

export interface BubbleMenuControlsProps {
  /** The Tiptap editor the bubble menu attaches to. */
  editor: Editor;
}

interface BubbleButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}

function BubbleButton({
  label,
  active,
  onClick,
  icon,
}: Readonly<BubbleButtonProps>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep the editor selection while clicking the bubble control.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-popover-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {icon}
    </button>
  );
}

interface BubbleLinkControlProps {
  editor: Editor;
}

function BubbleLinkControl({ editor }: Readonly<BubbleLinkControlProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const isActive = editor.isActive('link');

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
          className={cn(
            'focus-visible:ring-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none',
            isActive
              ? 'bg-primary/15 text-primary'
              : 'text-popover-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <LinkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] max-w-[260px] space-y-2.5 p-3">
        <label
          htmlFor="rte-bubble-link-url"
          className="text-foreground block text-xs font-semibold"
        >
          Link URL
        </label>
        <input
          id="rte-bubble-link-url"
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
 * Selection bubble menu for the `full` overview editor. Renders Bold, Italic, H2
 * and Link controls in a floating toolbar shown only when text is selected
 * (`@tiptap/extension-bubble-menu` handles the show/hide + positioning via its
 * bundled Floating UI). No persistent toolbar exists for the `full` variant —
 * these are the only mark/heading controls, complementing the `/` slash command.
 *
 * The bubble-menu extension is registered imperatively against this component's
 * ref'd element (Tiptap v3 ships no React `BubbleMenu` component). A transaction
 * subscription forces a re-render so `aria-pressed` reflects live mark state.
 */
export function BubbleMenuControls({
  editor,
}: Readonly<BubbleMenuControlsProps>): React.JSX.Element {
  const elementRef = useRef<HTMLDivElement>(null);
  // Force re-render on every editor transaction so active states stay live.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const element = elementRef.current;
    if (element === null) return;

    const pluginKey = 'proposalOverviewBubbleMenu';
    editor.registerPlugin(
      BubbleMenuPlugin({
        editor,
        element,
        pluginKey,
        // Only show for a non-empty text selection (not node/empty selections).
        shouldShow: ({ editor: ed, from, to }) => !ed.state.selection.empty && from !== to,
      })
    );

    const onTransaction = (): void => forceRender();
    editor.on('transaction', onTransaction);

    return () => {
      editor.off('transaction', onTransaction);
      editor.unregisterPlugin(pluginKey);
    };
  }, [editor]);

  return (
    <div
      ref={elementRef}
      // The bubble-menu plugin owns this element's visibility: it calls hide() in
      // its constructor (initial isVisible=false) and show()/hide() on selection,
      // toggling style.visibility + style.opacity. No initial inline style here so
      // the controls stay in the a11y tree for tests + screen readers when shown.
      className="border-border bg-popover flex items-center gap-1 rounded-lg border p-1 shadow-md"
    >
      <BubbleButton
        label="Bold"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        icon={<Bold className="h-4 w-4" aria-hidden="true" />}
      />
      <BubbleButton
        label="Italic"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        icon={<Italic className="h-4 w-4" aria-hidden="true" />}
      />
      <BubbleButton
        label="Heading 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        icon={<Heading2 className="h-4 w-4" aria-hidden="true" />}
      />
      <BubbleLinkControl editor={editor} />
    </div>
  );
}
