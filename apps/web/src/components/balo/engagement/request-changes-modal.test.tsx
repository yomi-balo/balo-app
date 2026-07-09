import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { RequestChangesModal } from './request-changes-modal';

const INTRO = 'The project goes back to active with your note attached — the window restarts then.';
const HINT = 'Be specific — this is exactly what Priya sees.';

function setup(overrides: Partial<React.ComponentProps<typeof RequestChangesModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <RequestChangesModal
      open
      intro={INTRO}
      fieldHint={HINT}
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
    expect(onConfirm).toHaveBeenCalledWith('  Fix the totals.  ');
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
});
