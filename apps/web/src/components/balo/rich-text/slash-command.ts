import { Extension, ReactRenderer, type Editor, type Range } from '@tiptap/react';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import { Heading2, Heading3, List, ListOrdered, type LucideIcon } from 'lucide-react';
import { SlashCommandMenu, type SlashCommandMenuHandle } from './slash-command-menu';

/**
 * A single `/` slash command. Pure config — `run(editor, range)` deletes the
 * `/query` range then applies the block transform. Restricted to the
 * `full`-overview allow-list (H2, H3, bullet list, numbered list); headings/lists
 * are the only block transforms the overview editor exposes via `/`.
 */
export interface SlashCommandItem {
  /** Stable key (used for React list keys + test lookup). */
  id: string;
  /** Menu label. */
  title: string;
  /** One-line helper shown under the title. */
  description: string;
  /** Extra search terms beyond the title for query matching. */
  keywords: ReadonlyArray<string>;
  /** Lucide icon component rendered in the menu. */
  icon: LucideIcon;
  /** Apply the command to the editor, replacing the `/query` range. */
  run: (editor: Editor, range: Range) => void;
}

/**
 * The locked slash-command set for the `full` overview editor. Bold/Italic/Link
 * are NOT here — they live on the bubble menu (selection-scoped marks, not block
 * inserts). These four are the block transforms that map cleanly to a `/` insert
 * and stay within `PROPOSAL_OVERVIEW_ALLOWED_TAGS`.
 */
export const SLASH_COMMANDS: ReadonlyArray<SlashCommandItem> = [
  {
    id: 'heading-2',
    title: 'Heading',
    description: 'Section heading',
    keywords: ['h2', 'title', 'section'],
    icon: Heading2,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'heading-3',
    title: 'Subheading',
    description: 'Smaller heading',
    keywords: ['h3', 'subtitle', 'subsection'],
    icon: Heading3,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet-list',
    title: 'Bullet list',
    description: 'Unordered list',
    keywords: ['ul', 'unordered', 'point'],
    icon: List,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'numbered-list',
    title: 'Numbered list',
    description: 'Ordered list',
    keywords: ['ol', 'ordered', 'number', 'step'],
    icon: ListOrdered,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
];

/**
 * Filter the command set by the post-`/` query (case-insensitive, matches title
 * or any keyword). Pure — unit-tested directly.
 */
export function filterSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.title.toLowerCase().includes(q) || cmd.keywords.some((k) => k.toLowerCase().includes(q))
  );
}

/** Position a fixed-position popup element at the given client rect. */
function positionAt(element: HTMLElement, rect: DOMRect | null): void {
  if (rect === null) {
    element.style.display = 'none';
    return;
  }
  element.style.display = 'block';
  element.style.position = 'fixed';
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.bottom + 6}px`;
  element.style.zIndex = '50';
}

/**
 * The suggestion `render()` lifecycle. Mounts `SlashCommandMenu` via
 * `ReactRenderer` into a fixed-position container positioned at the caret, wires
 * keyboard delegation to the menu's imperative handle, and tears everything down
 * on exit. Kept out of the pure exports so the command list stays trivially
 * testable without a DOM.
 */
function createSuggestionRender(): SuggestionOptions<SlashCommandItem>['render'] {
  return () => {
    let renderer: ReactRenderer<SlashCommandMenuHandle> | null = null;
    let container: HTMLElement | null = null;

    const update = (props: SuggestionProps<SlashCommandItem>): void => {
      if (container !== null) {
        positionAt(container, props.clientRect?.() ?? null);
      }
    };

    return {
      onStart: (props) => {
        container = document.createElement('div');
        document.body.appendChild(container);
        renderer = new ReactRenderer(SlashCommandMenu, {
          editor: props.editor,
          props: {
            items: props.items,
            onSelect: (item: SlashCommandItem) => props.command(item),
          },
        });
        container.appendChild(renderer.element);
        update(props);
      },
      onUpdate: (props) => {
        renderer?.updateProps({
          items: props.items,
          onSelect: (item: SlashCommandItem) => props.command(item),
        });
        update(props);
      },
      onKeyDown: (props) => {
        if (props.event.key === 'Escape') return false;
        return renderer?.ref?.onKeyDown(props.event) ?? false;
      },
      onExit: () => {
        renderer?.destroy();
        renderer = null;
        container?.remove();
        container = null;
      },
    };
  };
}

/**
 * The `/` slash-command extension for the `full` overview editor. Wraps
 * `@tiptap/suggestion`: typing `/` opens the menu, the filtered `SLASH_COMMANDS`
 * are offered, and selecting one runs its `run(editor, range)` transform. Only
 * attached for the `full` variant (see `rich-text-editor-impl.tsx`).
 */
export function createSlashCommandExtension(): Extension {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashCommandItem>({
          editor: this.editor,
          char: '/',
          // Only trigger at the start of a line — avoids hijacking inline "/".
          startOfLine: true,
          items: ({ query }) => filterSlashCommands(query),
          command: ({ editor, range, props }) => {
            props.run(editor, range);
          },
          render: createSuggestionRender(),
        }),
      ];
    },
  });
}
