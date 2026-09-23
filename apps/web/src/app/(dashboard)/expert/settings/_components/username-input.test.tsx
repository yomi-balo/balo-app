import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The action `import 'server-only'` — must be mocked or the import throws.
const { checkUsernameAction } = vi.hoisted(() => ({ checkUsernameAction: vi.fn() }));
vi.mock('../_actions/check-username', () => ({ checkUsernameAction }));

import { UsernameInput } from './username-input';

function Harness({
  initial = '',
  onChangeSpy,
}: Readonly<{ initial?: string; onChangeSpy?: (v: string) => void }>): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="username-field">Username</label>
      <UsernameInput
        id="username-field"
        value={value}
        onChange={(next) => {
          onChangeSpy?.(next);
          setValue(next);
        }}
        expertProfileId="profile-1"
      />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UsernameInput — addon', () => {
  it('attaches the balo.expert/experts/ prefix and is named by an outside label', () => {
    render(<Harness />);

    const input = screen.getByRole('textbox', { name: 'Username' });
    const prefix = screen.getByText('balo.expert/experts/');
    // The prefix and the input share one bordered box.
    expect(prefix.parentElement).toContainElement(input);
    expect(prefix.className).toContain('border-r');
    expect(input).toHaveAccessibleDescription(expect.stringContaining('balo.expert/experts/'));
  });

  it('keeps the standard height by default and takes a height from the caller', () => {
    const { rerender } = render(
      <UsernameInput value="" onChange={vi.fn()} expertProfileId="profile-1" />
    );
    const shell = (): HTMLElement | null => screen.getByText('balo.expert/experts/').parentElement;
    expect(shell()?.className.split(' ')).toContain('h-9');

    rerender(
      <UsernameInput
        value=""
        onChange={vi.fn()}
        expertProfileId="profile-1"
        className="h-11 sm:h-9"
      />
    );
    const classes = shell()?.className.split(' ') ?? [];
    expect(classes).toEqual(expect.arrayContaining(['h-11', 'sm:h-9', 'rounded-md']));
    expect(classes).not.toContain('h-9');
  });

  it('normalises typing to lowercase letters, digits and hyphens', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    checkUsernameAction.mockResolvedValue({ available: true });
    render(<Harness onChangeSpy={onChangeSpy} />);

    await user.type(screen.getByRole('textbox'), 'Jo_E!');

    expect(screen.getByRole('textbox')).toHaveValue('joe');
    expect(onChangeSpy).toHaveBeenLastCalledWith('joe');
  });
});

describe('UsernameInput — availability status', () => {
  it('stays quiet below three characters and never calls the action', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByRole('textbox'), 'ab');

    expect(screen.queryByText(/Checking/)).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(checkUsernameAction).not.toHaveBeenCalled();
  });

  it('shows "Checking…" then "Available" in the success tone', async () => {
    const user = userEvent.setup();
    checkUsernameAction.mockResolvedValue({ available: true });
    render(<Harness />);

    await user.type(screen.getByRole('textbox'), 'jane');

    expect(screen.getByText('Checking…')).toBeInTheDocument();
    const available = await screen.findByText('Available');
    expect(available.className).toContain('text-success-strong');
    expect(checkUsernameAction).toHaveBeenCalledWith({ username: 'jane' });
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('textbox')).toHaveAccessibleDescription(
      expect.stringContaining('Available')
    );
  });

  it('flags a taken username as invalid', async () => {
    const user = userEvent.setup();
    checkUsernameAction.mockResolvedValue({ available: false });
    render(<Harness />);

    await user.type(screen.getByRole('textbox'), 'taken-name');

    const message = await screen.findByText('Username already taken');
    expect(message.className.split(' ')).toContain('text-destructive-strong');
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.parentElement?.className).toContain('border-destructive');
  });

  it('shows the server-side rule the username breaks', async () => {
    const user = userEvent.setup();
    checkUsernameAction.mockResolvedValue({ available: false, error: 'That username is reserved' });
    render(<Harness />);

    await user.type(screen.getByRole('textbox'), 'admin');

    expect(await screen.findByText('That username is reserved')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('falls back to no status when the check itself fails', async () => {
    const user = userEvent.setup();
    checkUsernameAction.mockRejectedValue(new Error('network'));
    render(<Harness />);

    await user.type(screen.getByRole('textbox'), 'jane');

    await waitFor(() => expect(checkUsernameAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Checking…')).not.toBeInTheDocument());
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
  });

  it('checks a saved username on mount', async () => {
    checkUsernameAction.mockResolvedValue({ available: true });
    render(<Harness initial="jane-doe" />);

    expect(await screen.findByText('Available')).toBeInTheDocument();
    expect(checkUsernameAction).toHaveBeenCalledWith({ username: 'jane-doe' });
  });
});
