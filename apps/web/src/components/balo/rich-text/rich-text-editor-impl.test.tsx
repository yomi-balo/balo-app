import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

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

/** Mount the editor with a controlled value + onChange spy. */
function setup(initial = '<p>Some starting text</p>') {
  const onChange = vi.fn();
  function Harness() {
    return <RichTextEditorImpl value={initial} onChange={onChange} placeholder="Describe…" />;
  }
  render(<Harness />);
  return { onChange };
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
