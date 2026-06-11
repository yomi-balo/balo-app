'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEditor, EditorContent, type Editor, type AnyExtension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { motion, useReducedMotion } from 'motion/react';
import {
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Link as LinkIcon,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { PROPOSAL_OVERVIEW_ALLOWED_TAGS } from '@/lib/sanitize/allowed-tags';
import { normalizeLinkUrl, plainTextLength } from './plain-text';
import {
  RICH_TEXT_CONTENT_CLASS,
  type RichTextEditorProps,
  type RichTextEditorVariant,
} from './types';
import { createSlashCommandExtension } from './slash-command';
import { BubbleMenuControls } from './bubble-menu-controls';

/**
 * The widened overview allow-list is the single source the `full` editor's
 * node/mark set is derived from (so the editor can never emit a tag the server
 * sanitiser strips). `has(tag)` membership-tests it; the `standard`/`light`
 * variants use their own narrower hand-projected sets (see `VARIANT_TAGS`).
 */
const OVERVIEW_TAGS = new Set<string>(PROPOSAL_OVERVIEW_ALLOWED_TAGS);
const fullHas = (tag: string): boolean => OVERVIEW_TAGS.has(tag);

/** Which formatting nodes/marks each variant enables (toolbar + schema gate). */
type VariantFeatureSet = {
  bold: boolean;
  italic: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  link: boolean;
  blockquote: boolean;
  horizontalRule: boolean;
};

function featuresFor(variant: RichTextEditorVariant): VariantFeatureSet {
  if (variant === 'full') {
    // Derived from PROPOSAL_OVERVIEW_ALLOWED_TAGS (single source) — Bold, Italic,
    // H2, H3, bullet list, numbered list, Link, blockquote, horizontal rule.
    return {
      bold: fullHas('strong'),
      italic: fullHas('em'),
      h2: fullHas('h2'),
      h3: fullHas('h3'),
      bulletList: fullHas('ul'),
      orderedList: fullHas('ol'),
      link: fullHas('a'),
      blockquote: fullHas('blockquote'),
      horizontalRule: fullHas('hr'),
    };
  }
  if (variant === 'light') {
    // Milestone descriptions: Bold, Italic, bullet list, Link ONLY.
    return {
      bold: true,
      italic: true,
      h2: false,
      h3: false,
      bulletList: true,
      orderedList: false,
      link: true,
      blockquote: false,
      horizontalRule: false,
    };
  }
  // standard — the locked ADR-1022 brief set (unchanged).
  return {
    bold: true,
    italic: true,
    h2: true,
    h3: true,
    bulletList: true,
    orderedList: true,
    link: true,
    blockquote: false,
    horizontalRule: false,
  };
}

/**
 * StarterKit trimmed to a variant's feature set. We DISABLE everything outside the
 * variant's allow-list so the editor can never produce a tag the server sanitiser
 * would strip — the editor restriction and the sanitiser stay in lockstep
 * (`standard`/`light` use narrow hand sets; `full` is derived from the widened
 * `PROPOSAL_OVERVIEW_ALLOWED_TAGS`).
 */
function buildExtensions(
  placeholder: string,
  variant: RichTextEditorVariant,
  features: VariantFeatureSet
): AnyExtension[] {
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      heading: features.h2 || features.h3 ? { levels: [2, 3] } : false,
      bulletList: features.bulletList ? undefined : false,
      orderedList: features.orderedList ? undefined : false,
      blockquote: features.blockquote ? undefined : false,
      horizontalRule: features.horizontalRule ? undefined : false,
      bold: features.bold ? undefined : false,
      italic: features.italic ? undefined : false,
      codeBlock: false,
      code: false,
      strike: false,
      // Tiptap v3 StarterKit bundles a link extension; disable it so our
      // configured Link extension (below) is the single source.
      link: false,
    }),
  ];
  if (features.link) {
    extensions.push(
      Link.configure({
        openOnClick: false,
        autolink: false,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      })
    );
  }
  extensions.push(Placeholder.configure({ placeholder }));
  // The `/` slash command is a `full`-only contextual affordance.
  if (variant === 'full') {
    extensions.push(createSlashCommandExtension());
  }
  return extensions;
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

interface ToolbarProps {
  editor: Editor;
  features: VariantFeatureSet;
}

/**
 * The persistent toolbar for `standard` (full locked set) and `light` (Bold,
 * Italic, bullet list, Link). The `full` variant renders NO persistent toolbar —
 * it uses the bubble menu + slash command instead.
 */
function Toolbar({ editor, features }: Readonly<ToolbarProps>): React.JSX.Element {
  return (
    <div className="border-border bg-muted/40 sticky top-0 z-10 flex h-11 items-center gap-1 overflow-x-auto border-b px-2">
      {features.bold && (
        <ToolbarButton
          label="Bold"
          title="Bold (⌘B)"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          icon={<Bold className="h-4 w-4" aria-hidden="true" />}
        />
      )}
      {features.italic && (
        <ToolbarButton
          label="Italic"
          title="Italic (⌘I)"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          icon={<Italic className="h-4 w-4" aria-hidden="true" />}
        />
      )}
      {(features.h2 || features.h3) && <Separator orientation="vertical" className="mx-0.5 !h-5" />}
      {features.h2 && (
        <ToolbarButton
          label="Heading 2"
          title="Heading 2"
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          icon={<Heading2 className="h-4 w-4" aria-hidden="true" />}
        />
      )}
      {features.h3 && (
        <ToolbarButton
          label="Heading 3"
          title="Heading 3"
          active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          icon={<Heading3 className="h-4 w-4" aria-hidden="true" />}
        />
      )}
      {(features.bulletList || features.orderedList) && (
        <Separator orientation="vertical" className="mx-0.5 !h-5" />
      )}
      {features.bulletList && (
        <ToolbarButton
          label="Bullet list"
          title="Bullet list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          icon={<List className="h-4 w-4" aria-hidden="true" />}
        />
      )}
      {features.orderedList && (
        <ToolbarButton
          label="Numbered list"
          title="Numbered list"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          icon={<ListOrdered className="h-4 w-4" aria-hidden="true" />}
        />
      )}
      {features.link && <Separator orientation="vertical" className="mx-0.5 !h-5" />}
      {features.link && <LinkPopover editor={editor} />}
    </div>
  );
}

/** Collapsed height for a blurred `full` overview with long content (~3 lines). */
const COLLAPSED_MAX_HEIGHT = 84;
/** Plain-text length past which a blurred overview is considered "long". */
const COLLAPSE_TEXT_THRESHOLD = 160;

/**
 * Heavy Tiptap editor — code-split behind a dynamic import (see the
 * `rich-text-editor.tsx` wrapper) so it never ships in the initial bundle.
 * Emits sanitisable HTML on every change; the parent debounces it into autosave.
 *
 * Three variants:
 *  - `standard` (default): persistent locked toolbar (Bold, Italic | H2, H3 |
 *    Bullet, Numbered | Link). Unchanged.
 *  - `light`: minimal persistent toolbar (Bold, Italic, bullet list, Link).
 *  - `full`: NO persistent toolbar — selection bubble menu + `/` slash command,
 *    plus optional collapse-on-blur (~3 lines + "Show full overview").
 */
export default function RichTextEditorImpl({
  value,
  onChange,
  placeholder,
  ariaLabel = 'Project description',
  className,
  variant = 'standard',
  collapseOnBlur = false,
}: Readonly<RichTextEditorProps>): React.JSX.Element {
  const features = useMemo(() => featuresFor(variant), [variant]);
  const reduceMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const editor = useEditor({
    extensions: buildExtensions(placeholder ?? '', variant, features),
    content: value,
    // Avoid SSR hydration mismatch (we already gate with ssr:false, but Tiptap
    // recommends this explicitly).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        role: 'textbox',
        'aria-multiline': 'true',
        class: `text-foreground min-h-[180px] max-h-[340px] overflow-y-auto px-3.5 py-3 text-sm leading-relaxed focus:outline-none ${RICH_TEXT_CONTENT_CLASS}`,
      },
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
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

  // `full` variant: contextual controls only (no persistent toolbar) +
  // optional collapse-on-blur.
  if (variant === 'full') {
    const isLong = plainTextLength(value) > COLLAPSE_TEXT_THRESHOLD;
    const collapsed = collapseOnBlur && !focused && !expanded && isLong;
    const regionId = 'rte-overview-region';

    return (
      <div
        className={cn(
          'border-border bg-card focus-within:border-ring focus-within:ring-ring/30 overflow-hidden rounded-[11px] border transition-shadow focus-within:ring-[3px]',
          className
        )}
      >
        <BubbleMenuControls editor={editor} />
        <motion.div
          id={regionId}
          className="overflow-hidden"
          initial={false}
          animate={{ maxHeight: collapsed ? COLLAPSED_MAX_HEIGHT : 340 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: 'easeInOut' }}
        >
          <EditorContent editor={editor} />
        </motion.div>
        {collapsed && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={!collapsed}
            aria-controls={regionId}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 flex w-full items-center justify-center gap-1.5 border-t px-3 py-2 text-xs font-medium transition-colors"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            Show full overview
          </button>
        )}
      </div>
    );
  }

  // `standard` + `light`: persistent toolbar.
  return (
    <div
      className={cn(
        'border-border bg-card focus-within:border-ring focus-within:ring-ring/30 overflow-hidden rounded-[11px] border transition-shadow focus-within:ring-[3px]',
        className
      )}
    >
      <Toolbar editor={editor} features={features} />
      <EditorContent editor={editor} />
    </div>
  );
}
