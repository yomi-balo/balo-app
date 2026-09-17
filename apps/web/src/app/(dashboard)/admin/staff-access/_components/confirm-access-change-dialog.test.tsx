import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ConfirmAccessChangeDialog } from './confirm-access-change-dialog';

const EMPTY = new Set<never>();

function baseProps(
  overrides: Partial<React.ComponentProps<typeof ConfirmAccessChangeDialog>> = {}
) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    firstName: 'Adeeb',
    pending: false,
    onConfirm: vi.fn(),
    roleBefore: 'admin' as const,
    roleAfter: 'admin' as const,
    before: EMPTY,
    after: EMPTY,
    customListBefore: false,
    customListAfter: false,
    error: null,
    onReload: vi.fn(),
    ...overrides,
  };
}

describe('ConfirmAccessChangeDialog', () => {
  it('renders the title with the first name', () => {
    render(<ConfirmAccessChangeDialog {...baseProps()} />);
    expect(screen.getByText('Change Adeeb’s access?')).toBeInTheDocument();
  });

  it('calls onConfirm when "Save changes" is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmAccessChangeDialog {...baseProps({ onConfirm })} />);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows "Saving…" and disables both buttons while pending', () => {
    render(<ConfirmAccessChangeDialog {...baseProps({ pending: true })} />);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('renders no error banner when there is no error', () => {
    render(<ConfirmAccessChangeDialog {...baseProps()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the error message, and a Reload button only when needsReload', async () => {
    const onReload = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmAccessChangeDialog
        {...baseProps({
          error: {
            message: 'This person’s access changed since you opened it.',
            needsReload: true,
          },
          onReload,
        })}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/changed since you opened it/i);
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders the error message with no Reload button when needsReload is false', () => {
    render(
      <ConfirmAccessChangeDialog
        {...baseProps({
          error: { message: 'You cannot change your own access.', needsReload: false },
        })}
      />
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();
  });
});
