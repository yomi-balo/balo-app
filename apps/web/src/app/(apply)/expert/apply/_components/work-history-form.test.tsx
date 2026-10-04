import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// The real editor is Tiptap, code-split behind `next/dynamic`; it has its own suite. This stub
// exposes the same contract — an HTML `value` in, HTML out through `onChange` — on a textarea.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    ariaLabel,
    variant,
  }: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
    variant?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      data-variant={variant}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { WorkHistoryForm } from './work-history-form';

const ENTRY = {
  id: 'wh-1',
  role: 'Senior Consultant',
  company: 'Acme Corp',
  startedAt: '2020-01-01',
  endedAt: '2023-06-01',
  isCurrent: false,
};

const onSave = vi.fn();

function renderForm(responsibilities?: string): void {
  render(
    <WorkHistoryForm
      initialData={{ ...ENTRY, responsibilities }}
      onSave={onSave}
      onCancel={vi.fn()}
    />
  );
}

function editor(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Responsibilities' });
}

function setResponsibilities(html: string): void {
  fireEvent.change(editor(), { target: { value: html } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkHistoryForm — responsibilities', () => {
  it('edits responsibilities in the shared rich-text editor, light variant', () => {
    renderForm('<p>Led delivery</p>');
    expect(editor()).toHaveAttribute('data-variant', 'light');
    expect(editor()).toHaveValue('<p>Led delivery</p>');
  });

  it('opens an entry saved as plain text with its lines as paragraphs', () => {
    renderForm('Led delivery\nRan CPQ & billing');
    expect(editor()).toHaveValue('<p>Led delivery</p><p>Ran CPQ &amp; billing</p>');
  });

  it('counts visible characters, not markup', () => {
    renderForm('<p><strong>Led</strong></p>');
    expect(screen.getByText('3/1000')).toBeInTheDocument();
  });

  it('saves the editor HTML as entered', async () => {
    const user = userEvent.setup();
    renderForm();
    setResponsibilities('<ul><li><strong>Led</strong> delivery</li></ul>');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        responsibilities: '<ul><li><strong>Led</strong> delivery</li></ul>',
      })
    );
  });

  it("saves nothing for the editor's empty document", async () => {
    const user = userEvent.setup();
    renderForm('<p>Led delivery</p>');
    setResponsibilities('<p></p>');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ responsibilities: '' }));
  });

  it('refuses more than 1,000 visible characters and says why', async () => {
    const user = userEvent.setup();
    renderForm();
    setResponsibilities(`<p>${'a'.repeat(1001)}</p>`);

    expect(screen.getByText('1001/1000')).toHaveClass('text-destructive');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Keep responsibilities under 1000 characters.')).toBeInTheDocument();
  });
});
