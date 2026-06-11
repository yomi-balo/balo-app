import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// motion/react animates the full-variant collapse; stub it so max-height
// animation doesn't depend on layout APIs jsdom lacks.
const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'variants', 'transition']);
vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

// BubbleMenuControls registers a real Floating-UI-backed ProseMirror plugin that
// jsdom can't measure; its own test covers that wiring. Here we stub it with a
// lightweight surface that renders the same accessible controls so the full
// variant's "renders bubble controls, no persistent toolbar" branch is verified
// without a real plugin registration.
vi.mock('./bubble-menu-controls', () => ({
  BubbleMenuControls: () => (
    <div data-testid="bubble-menu-controls">
      <button type="button" aria-label="Bold" />
      <button type="button" aria-label="Italic" />
      <button type="button" aria-label="Heading 2" />
      <button type="button" aria-label="Insert link" />
    </div>
  ),
}));

// ProseMirror (Tiptap) relies on a few layout APIs jsdom doesn't implement.
// Stub them so the editor mounts + handles selection in component tests.
beforeAll(() => {
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null;
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
  }
});

import RichTextEditorImpl from './rich-text-editor-impl';

type SetupOptions = Partial<
  Pick<React.ComponentProps<typeof RichTextEditorImpl>, 'variant' | 'collapseOnBlur'>
>;

/** Mount the editor with a controlled value + onChange spy. */
function setup(initial = '<p>Some starting text</p>', options: SetupOptions = {}) {
  const onChange = vi.fn();
  function Harness() {
    return (
      <RichTextEditorImpl
        value={initial}
        onChange={onChange}
        placeholder="Describe…"
        {...options}
      />
    );
  }
  const result = render(<Harness />);
  return { onChange, ...result };
}

describe('RichTextEditorImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the locked toolbar in order with accessible labels', async () => {
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument());
    // Exact locked set + order: Bold, Italic, H2, H3, Bullet, Numbered, Link.
    for (const label of [
      'Bold',
      'Italic',
      'Heading 2',
      'Heading 3',
      'Bullet list',
      'Numbered list',
      'Insert link',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('exposes the editable region with an accessible name', async () => {
    setup();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Project description' })).toBeInTheDocument()
    );
  });

  it('toolbar buttons expose aria-pressed reflecting (inactive) state on mount', async () => {
    setup();
    for (const label of ['Bold', 'Italic', 'Heading 2', 'Bullet list']) {
      const btn = await screen.findByRole('button', { name: label });
      expect(btn).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('disables the Link button when there is no selection', async () => {
    setup('<p>Some starting text</p>');
    const linkBtn = await screen.findByRole('button', { name: 'Insert link' });
    // No selection on mount → the link affordance is disabled (design §2.3).
    expect(linkBtn).toBeDisabled();
  });

  it('emits HTML on edit', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('<p></p>');
    const region = await screen.findByRole('textbox', { name: 'Project description' });
    await user.click(region);
    await user.keyboard('Hello');
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const lastCall = onChange.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toContain('Hello');
  });

  it('toggling Bold then typing emits bold HTML', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('<p></p>');
    const region = await screen.findByRole('textbox', { name: 'Project description' });
    await user.click(region);
    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.keyboard('bolded');
    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] as string;
      expect(html).toMatch(/<strong>/);
    });
  });
});

describe('RichTextEditorImpl — light variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a minimal persistent mini-toolbar: Bold, Italic, Bullet list, Link only', async () => {
    setup('<p>x</p>', { variant: 'light' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument());
    for (const label of ['Bold', 'Italic', 'Bullet list', 'Insert link']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('excludes Heading 2, Heading 3 and Numbered list', async () => {
    setup('<p>x</p>', { variant: 'light' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Heading 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Heading 3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Numbered list' })).not.toBeInTheDocument();
  });
});

describe('RichTextEditorImpl — full variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders NO persistent toolbar (contextual controls only)', async () => {
    setup('<p>An overview</p>', { variant: 'full' });
    const region = await screen.findByRole('textbox', { name: 'Project description' });
    expect(region).toBeInTheDocument();
    // No persistent toolbar list-controls: H3 + Numbered list never render for full.
    expect(screen.queryByRole('button', { name: 'Heading 3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Numbered list' })).not.toBeInTheDocument();
  });

  it('renders the selection bubble-menu controls (Bold, Italic, H2, Link)', async () => {
    setup('<p>An overview</p>', { variant: 'full' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument());
    for (const label of ['Bold', 'Italic', 'Heading 2', 'Insert link']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('does NOT collapse when collapseOnBlur is false', async () => {
    setup('<p>An overview</p>', { variant: 'full', collapseOnBlur: false });
    await screen.findByRole('textbox', { name: 'Project description' });
    expect(screen.queryByRole('button', { name: /Show full overview/ })).not.toBeInTheDocument();
  });

  it('does NOT collapse short content even when collapseOnBlur is true (blurred on mount)', async () => {
    setup('<p>short</p>', { variant: 'full', collapseOnBlur: true });
    await screen.findByRole('textbox', { name: 'Project description' });
    // Below the long-content threshold → no collapse affordance.
    expect(screen.queryByRole('button', { name: /Show full overview/ })).not.toBeInTheDocument();
  });

  it('collapses long content on blur and exposes "Show full overview"; clicking expands', async () => {
    const user = userEvent.setup();
    const longHtml = `<p>${'word '.repeat(60)}</p>`; // > 160 plain-text chars
    setup(longHtml, { variant: 'full', collapseOnBlur: true });
    // Editor is blurred on mount → collapsed affordance present.
    const showBtn = await screen.findByRole('button', { name: /Show full overview/ });
    expect(showBtn).toBeInTheDocument();
    // The collapse control announces the region state + targets it for a11y.
    expect(showBtn).toHaveAttribute('aria-expanded', 'false');
    expect(showBtn).toHaveAttribute('aria-controls', 'rte-overview-region');
    await user.click(showBtn);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Show full overview/ })).not.toBeInTheDocument()
    );
  });
});
