import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import { BubbleMenuControls } from './bubble-menu-controls';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// The real BubbleMenuPlugin pulls in Floating UI + DOM measurement APIs jsdom
// doesn't implement. Stub it to a no-op ProseMirror-plugin-shaped object so the
// component's registerPlugin call is exercised without a real editor view.
vi.mock('@tiptap/extension-bubble-menu', () => ({
  BubbleMenuPlugin: vi.fn(() => ({ spec: {}, props: {} })),
}));

import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu';

/** A chainable editor stub recording mark toggles + plugin lifecycle calls. */
function createEditorStub(active: Record<string, boolean> = {}): {
  editor: Editor;
  toggles: string[];
  registered: boolean;
} {
  const toggles: string[] = [];
  let registered = false;
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]): unknown => {
      if (name.startsWith('toggle')) {
        toggles.push(args.length > 0 ? `${name}:${JSON.stringify(args[0])}` : name);
      }
      return chain;
    };
  for (const m of [
    'chain',
    'focus',
    'toggleBold',
    'toggleItalic',
    'toggleHeading',
    'extendMarkRange',
    'setLink',
    'unsetLink',
    'run',
  ]) {
    chain[m] = record(m);
  }
  const editor = {
    ...chain,
    isActive: (name: string, attrs?: Record<string, unknown>) =>
      attrs ? Boolean(active[`${name}:${JSON.stringify(attrs)}`]) : Boolean(active[name]),
    getAttributes: () => ({}),
    registerPlugin: vi.fn(() => {
      registered = true;
    }),
    unregisterPlugin: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
  return {
    editor,
    toggles,
    get registered() {
      return registered;
    },
  };
}

describe('BubbleMenuControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Bold, Italic, Heading 2 and Insert link controls', () => {
    const { editor } = createEditorStub();
    render(<BubbleMenuControls editor={editor} />);
    for (const label of ['Bold', 'Italic', 'Heading 2', 'Insert link']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('does NOT render H3 / list controls (those are not bubble-menu actions)', () => {
    const { editor } = createEditorStub();
    render(<BubbleMenuControls editor={editor} />);
    expect(screen.queryByRole('button', { name: 'Heading 3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bullet list' })).not.toBeInTheDocument();
  });

  it('registers the bubble-menu ProseMirror plugin against its element', () => {
    const stub = createEditorStub();
    render(<BubbleMenuControls editor={stub.editor} />);
    expect(BubbleMenuPlugin).toHaveBeenCalledTimes(1);
    const opts = (BubbleMenuPlugin as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pluginKey: string;
      element: HTMLElement;
    };
    expect(opts.pluginKey).toBe('proposalOverviewBubbleMenu');
    expect(opts.element).toBeInstanceOf(HTMLElement);
    expect(stub.registered).toBe(true);
  });

  it('Bold toggles the bold mark', async () => {
    const user = userEvent.setup();
    const stub = createEditorStub();
    render(<BubbleMenuControls editor={stub.editor} />);
    await user.click(screen.getByRole('button', { name: 'Bold' }));
    expect(stub.toggles).toContain('toggleBold');
  });

  it('Heading 2 toggles heading level 2', async () => {
    const user = userEvent.setup();
    const stub = createEditorStub();
    render(<BubbleMenuControls editor={stub.editor} />);
    await user.click(screen.getByRole('button', { name: 'Heading 2' }));
    expect(stub.toggles).toContain('toggleHeading:{"level":2}');
  });

  it('reflects active mark state via aria-pressed', () => {
    const { editor } = createEditorStub({ bold: true });
    render(<BubbleMenuControls editor={editor} />);
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the link popover and rejects an unsafe URL', async () => {
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    const { editor } = createEditorStub();
    render(<BubbleMenuControls editor={editor} />);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    const input = await screen.findByLabelText('Link URL');
    await user.type(input, 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(toast.error).toHaveBeenCalledWith('Links must start with http:// or https://');
  });
});
