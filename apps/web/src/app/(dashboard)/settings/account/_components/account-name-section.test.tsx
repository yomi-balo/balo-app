import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { toast } from 'sonner';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';

const mockUpdateNameAction = vi.fn();
vi.mock('@/lib/auth/actions/update-name', () => ({
  updateNameAction: (...a: unknown[]) => mockUpdateNameAction(...a),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh, back: vi.fn() }),
}));

import { AccountNameSection } from './account-name-section';

function renderSection(firstName = 'Dana', lastName = 'Reyes'): ReturnType<typeof render> {
  return render(<AccountNameSection initialFirstName={firstName} initialLastName={lastName} />);
}

const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Save name' });

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateNameAction.mockResolvedValue({ success: true });
});

describe('AccountNameSection', () => {
  it('shows the current name in editable fields with name autocomplete', () => {
    renderSection();
    const first = screen.getByLabelText('First name');
    const last = screen.getByLabelText('Last name');
    expect(first).toHaveValue('Dana');
    expect(last).toHaveValue('Reyes');
    expect(first).toHaveAttribute('autocomplete', 'given-name');
    expect(last).toHaveAttribute('autocomplete', 'family-name');
    expect(first).toHaveAttribute('maxlength', '50');
  });

  it('keeps Save disabled until the name actually changes — whitespace alone is not a change', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(saveButton()).toBeDisabled();

    await user.type(screen.getByLabelText('First name'), '  ');
    expect(saveButton()).toBeDisabled();

    await user.type(screen.getByLabelText('First name'), 'x');
    expect(saveButton()).toBeEnabled();
  });

  it('saves the trimmed name, confirms it, refreshes the shell, and re-baselines', async () => {
    const user = userEvent.setup();
    renderSection();

    const first = screen.getByLabelText('First name');
    await user.clear(first);
    await user.type(first, '  Maya ');
    await user.click(saveButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Name updated.'));
    expect(mockUpdateNameAction).toHaveBeenCalledWith({ firstName: 'Maya', lastName: 'Reyes' });
    expect(track).toHaveBeenCalledWith(SETTINGS_EVENTS.NAME_UPDATED, {
      surface: 'account',
      fields_changed: ['first_name'],
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(first).toHaveValue('Maya');
    expect(saveButton()).toBeDisabled();
  });

  it('refuses an empty name with an inline message and saves nothing; editing clears it', async () => {
    const user = userEvent.setup();
    renderSection();

    const last = screen.getByLabelText('Last name');
    await user.clear(last);
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Last name is required');
    expect(last).toHaveAttribute('aria-invalid', 'true');
    expect(last).toHaveAccessibleDescription('Last name is required');
    expect(mockUpdateNameAction).not.toHaveBeenCalled();

    await user.type(last, 'R');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses angle brackets, the same rule the server enforces', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText('First name'), '<b>');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Name contains invalid characters');
    expect(mockUpdateNameAction).not.toHaveBeenCalled();
  });

  it('lets an account stored without a last name add one', async () => {
    const user = userEvent.setup();
    renderSection('Dana', '');

    await user.type(screen.getByLabelText('Last name'), 'Reyes');
    await user.click(saveButton());

    await waitFor(() =>
      expect(mockUpdateNameAction).toHaveBeenCalledWith({ firstName: 'Dana', lastName: 'Reyes' })
    );
  });

  it('toasts a returned error verbatim and keeps the draft so nothing is re-typed', async () => {
    mockUpdateNameAction.mockResolvedValue({ success: false, error: 'Something went wrong.' });
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText('First name'), 'x');
    await user.click(saveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong.'));
    expect(track).not.toHaveBeenCalled();
    expect(screen.getByLabelText('First name')).toHaveValue('Danax');
    expect(saveButton()).toBeEnabled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('toasts the generic failure when the action throws', async () => {
    mockUpdateNameAction.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText('First name'), 'x');
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't save your name — please try again.")
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <div>
        <h1>Account</h1>
        <AccountNameSection initialFirstName="Dana" initialLastName="Reyes" />
      </div>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
