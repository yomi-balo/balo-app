import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { AcceptProjectModal } from './accept-project-modal';

const BODY = "Accepting confirms the delivery — it can't be un-accepted afterwards.";

function setup(overrides: Partial<React.ComponentProps<typeof AcceptProjectModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <AcceptProjectModal
      open
      body={BODY}
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('AcceptProjectModal', () => {
  it('renders the title and the pre-derived consequence body', () => {
    setup();
    expect(screen.getByText('Accept this project')).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('confirms and cancels via the footer buttons', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: /Accept project/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('is sticky while pending: the confirm is disabled and the close (X) is hidden', () => {
    setup({ pending: true });
    expect(screen.getByRole('button', { name: /Accept project/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});
