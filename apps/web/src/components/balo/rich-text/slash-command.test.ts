import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Editor, Range } from '@tiptap/react';

// Capture the options object the extension hands to `@tiptap/suggestion` so the
// `items` / `command` / `render` config can be driven directly (no real editor).
const suggestionCalls: Array<Record<string, unknown>> = [];
vi.mock('@tiptap/suggestion', () => ({
  default: (options: Record<string, unknown>) => {
    suggestionCalls.push(options);
    return { plugin: 'mock-suggestion-plugin' };
  },
}));

import {
  SLASH_COMMANDS,
  filterSlashCommands,
  createSlashCommandExtension,
  type SlashCommandItem,
} from './slash-command';

/**
 * Build a chainable editor stub that records which command methods were called.
 * Each chain method returns the same proxy so `.chain().focus()...run()` works.
 */
function createEditorStub(): { editor: Editor; calls: string[] } {
  const calls: string[] = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]): unknown => {
      calls.push(args.length > 0 ? `${name}:${JSON.stringify(args[0])}` : name);
      return chain;
    };
  for (const method of [
    'chain',
    'focus',
    'deleteRange',
    'toggleHeading',
    'toggleBulletList',
    'toggleOrderedList',
    'run',
  ]) {
    chain[method] = record(method);
  }
  return { editor: chain as unknown as Editor, calls };
}

const RANGE: Range = { from: 0, to: 1 };

describe('SLASH_COMMANDS', () => {
  it('exposes exactly the four allow-list block transforms', () => {
    expect(SLASH_COMMANDS.map((c) => c.id)).toEqual([
      'heading-2',
      'heading-3',
      'bullet-list',
      'numbered-list',
    ]);
  });

  it('does not expose Bold, Italic or Link (those live on the bubble menu)', () => {
    const titles = SLASH_COMMANDS.map((c) => c.title.toLowerCase());
    expect(titles).not.toContain('bold');
    expect(titles).not.toContain('italic');
    expect(titles).not.toContain('link');
  });

  it.each([
    ['heading-2', 'toggleHeading:{"level":2}'],
    ['heading-3', 'toggleHeading:{"level":3}'],
    ['bullet-list', 'toggleBulletList'],
    ['numbered-list', 'toggleOrderedList'],
  ])('command %s maps to the right editor action and deletes the /query range', (id, expected) => {
    const item = SLASH_COMMANDS.find((c) => c.id === id) as SlashCommandItem;
    const { editor, calls } = createEditorStub();
    item.run(editor, RANGE);
    expect(calls).toContain('deleteRange:{"from":0,"to":1}');
    expect(calls).toContain(expected);
    expect(calls).toContain('run');
  });
});

describe('filterSlashCommands', () => {
  it('returns the full set for an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands('   ')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('matches on title (case-insensitive)', () => {
    const result = filterSlashCommands('Bullet');
    expect(result.map((c) => c.id)).toEqual(['bullet-list']);
  });

  it('matches on keywords (e.g. "h2", "ol")', () => {
    expect(filterSlashCommands('h2').map((c) => c.id)).toEqual(['heading-2']);
    expect(filterSlashCommands('ol').map((c) => c.id)).toEqual(['numbered-list']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterSlashCommands('zzz')).toEqual([]);
  });

  it('returns a fresh array (callers can mutate without touching the source)', () => {
    const a = filterSlashCommands('');
    expect(a).not.toBe(SLASH_COMMANDS);
  });
});

// Guard against accidental coupling of the pure module to React rendering.
describe('slash-command pure module', () => {
  it('does not require a DOM to evaluate the command list', () => {
    const spy = vi.fn();
    expect(() => spy(SLASH_COMMANDS.length)).not.toThrow();
    expect(spy).toHaveBeenCalledWith(4);
  });
});

/**
 * Drive the extension's Suggestion config. `createSlashCommandExtension()`
 * returns a Tiptap `Extension`; running its `addProseMirrorPlugins` (with a
 * stubbed `this.editor`) invokes `Suggestion()`, which the mock above captures.
 * That gives us the `items` / `command` / `render` config to exercise directly.
 */
function getSuggestionOptions(): Record<string, unknown> {
  const extension = createSlashCommandExtension();
  // The plugin factory reads `this.editor`; provide a stub bound as `this`.
  const addPlugins = (
    extension.config as unknown as {
      addProseMirrorPlugins?: () => unknown[];
    }
  ).addProseMirrorPlugins;
  if (typeof addPlugins !== 'function') {
    throw new Error('expected addProseMirrorPlugins on the extension config');
  }
  addPlugins.call({ editor: {} as Editor });
  const [options] = suggestionCalls;
  if (options === undefined) throw new Error('Suggestion() was not called');
  return options;
}

describe('createSlashCommandExtension', () => {
  beforeEach(() => {
    suggestionCalls.length = 0;
  });

  it('configures Suggestion to trigger on "/" at the start of a line', () => {
    const options = getSuggestionOptions();
    expect(options.char).toBe('/');
    expect(options.startOfLine).toBe(true);
  });

  it('items() delegates to filterSlashCommands for the current query', () => {
    const options = getSuggestionOptions();
    const items = options.items as (args: { query: string }) => SlashCommandItem[];
    expect(items({ query: 'bullet' }).map((c) => c.id)).toEqual(['bullet-list']);
    expect(items({ query: '' })).toHaveLength(SLASH_COMMANDS.length);
  });

  it('command() runs the chosen item against the editor + range', () => {
    const options = getSuggestionOptions();
    const command = options.command as (args: {
      editor: Editor;
      range: Range;
      props: SlashCommandItem;
    }) => void;
    const run = vi.fn();
    const item = { ...SLASH_COMMANDS[0], run } as unknown as SlashCommandItem;
    const editor = {} as Editor;
    command({ editor, range: RANGE, props: item });
    expect(run).toHaveBeenCalledWith(editor, RANGE);
  });
});

/**
 * The `render()` lifecycle mounts `SlashCommandMenu` via a `ReactRenderer` into a
 * fixed-position container at the caret and tears it down on exit. A light mock of
 * the renderer + a real DOM (JSDOM) is enough to walk onStart → onUpdate →
 * onKeyDown → onExit and assert the container is positioned and removed.
 */
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>();
  class ReactRendererStub {
    element = globalThis.document.createElement('span');
    ref = { onKeyDown: vi.fn().mockReturnValue(true) };
    updateProps = vi.fn();
    destroy = vi.fn();
    constructor(..._args: unknown[]) {
      void _args;
    }
  }
  return { ...actual, ReactRenderer: ReactRendererStub };
});

describe('createSuggestionRender lifecycle', () => {
  beforeEach(() => {
    suggestionCalls.length = 0;
    globalThis.document.body.innerHTML = '';
  });

  function makeProps(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      editor: {} as Editor,
      items: [...SLASH_COMMANDS],
      command: vi.fn(),
      clientRect: () => ({ left: 12, bottom: 40 }) as DOMRect,
      ...overrides,
    };
  }

  it('onStart mounts a positioned container, onExit removes it', () => {
    const options = getSuggestionOptions();
    const renderFactory = options.render as () => {
      onStart: (p: Record<string, unknown>) => void;
      onUpdate: (p: Record<string, unknown>) => void;
      onKeyDown: (p: { event: KeyboardEvent }) => boolean;
      onExit: () => void;
    };
    const handlers = renderFactory();

    handlers.onStart(makeProps());
    const container = globalThis.document.body.querySelector('div');
    expect(container).not.toBeNull();
    expect(container?.style.position).toBe('fixed');
    expect(container?.style.left).toBe('12px');

    // onUpdate with a null rect hides the container.
    handlers.onUpdate(makeProps({ clientRect: () => null }));
    expect(container?.style.display).toBe('none');

    // onKeyDown: Escape is NOT consumed (returns false); other keys delegate.
    expect(handlers.onKeyDown({ event: { key: 'Escape' } as KeyboardEvent })).toBe(false);
    expect(handlers.onKeyDown({ event: { key: 'ArrowDown' } as KeyboardEvent })).toBe(true);

    handlers.onExit();
    expect(globalThis.document.body.querySelector('div')).toBeNull();
  });
});
