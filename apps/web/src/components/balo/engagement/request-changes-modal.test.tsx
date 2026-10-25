import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { RequestChangesModal } from './request-changes-modal';

const INTRO = 'The project goes back to active with your note attached — the window restarts then.';
const HINT = 'Be specific — this is exactly what Priya sees.';
const HELPER = 'Milestones you pick go back to Priya with your feedback.';
const OPTIONS = [
  { id: 'm-1', title: 'Discovery' },
  { id: 'm-2', title: 'Build' },
  { id: 'm-3', title: 'Launch' },
];

function setup(overrides: Partial<React.ComponentProps<typeof RequestChangesModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <RequestChangesModal
      open
      intro={INTRO}
      fieldHint={HINT}
      milestoneOptions={OPTIONS}
      milestoneHelper={HELPER}
      initialNote=""
      initialMilestoneIds={[]}
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('RequestChangesModal', () => {
  it('renders the intro and the party-named field hint', () => {
    setup();
    expect(screen.getByText(INTRO)).toBeInTheDocument();
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('keeps Send disabled until the note is non-empty, then passes it to onConfirm', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    const send = screen.getByRole('button', { name: /Send change request/i });
    expect(send).toBeDisabled();

    await user.type(screen.getByLabelText(/What needs to change/i), '  Fix the totals.  ');
    expect(send).toBeEnabled();
    await user.click(send);
    // The raw field value is passed through; the Server Action trims + validates.
    expect(onConfirm).toHaveBeenCalledWith('  Fix the totals.  ', []);
  });

  it('offers every milestone as an optional checkbox with the helper line', () => {
    setup();
    expect(screen.getByText(/Is this about particular milestones\?/)).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText(HELPER)).toBeInTheDocument();
  });

  it('passes the ticked milestone ids in plan order, whatever order they were ticked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.type(screen.getByLabelText(/What needs to change/i), 'Redo these.');
    await user.click(screen.getByRole('checkbox', { name: 'Launch' }));
    await user.click(screen.getByRole('checkbox', { name: 'Discovery' }));
    await user.click(screen.getByRole('button', { name: /Send change request/i }));
    expect(onConfirm).toHaveBeenCalledWith('Redo these.', ['m-1', 'm-3']);
  });

  it('un-ticking a milestone removes it from the selection', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.type(screen.getByLabelText(/What needs to change/i), 'Redo.');
    await user.click(screen.getByRole('checkbox', { name: 'Build' }));
    await user.click(screen.getByRole('checkbox', { name: 'Build' }));
    await user.click(screen.getByRole('button', { name: /Send change request/i }));
    expect(onConfirm).toHaveBeenCalledWith('Redo.', []);
  });

  it('hides the milestone section when there are no milestones to tag', () => {
    setup({ milestoneOptions: [] });
    expect(screen.queryByText(/particular milestones/)).not.toBeInTheDocument();
    expect(screen.queryByText(HELPER)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('clears the selection and note when the dialog is reopened', async () => {
    const user = userEvent.setup();
    const props = {
      intro: INTRO,
      fieldHint: HINT,
      milestoneOptions: OPTIONS,
      milestoneHelper: HELPER,
      initialNote: '',
      initialMilestoneIds: [],
      pending: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(<RequestChangesModal open {...props} />);
    await user.click(screen.getByRole('checkbox', { name: 'Build' }));
    expect(screen.getByRole('checkbox', { name: 'Build' })).toBeChecked();

    rerender(<RequestChangesModal open={false} {...props} />);
    rerender(<RequestChangesModal open {...props} />);
    expect(screen.getByRole('checkbox', { name: 'Build' })).not.toBeChecked();
  });

  it('treats a whitespace-only note as empty (Send stays disabled)', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText(/What needs to change/i), '   ');
    expect(screen.getByRole('button', { name: /Send change request/i })).toBeDisabled();
  });

  it('is sticky while pending: the close (X) is hidden', () => {
    setup({ pending: true });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
  it('starts from the held draft when opened', () => {
    setup({ initialNote: 'Held draft.', initialMilestoneIds: ['m-2'] });
    expect(screen.getByLabelText(/What needs to change/i)).toHaveValue('Held draft.');
    expect(screen.getByRole('checkbox', { name: 'Build' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Discovery' })).not.toBeChecked();
  });

  it('scrolls the milestone list inside the dialog', () => {
    setup();
    const list = screen.getByRole('checkbox', { name: 'Discovery' }).closest('.overflow-y-auto');
    expect(list).toHaveClass('max-h-56');
  });
});
