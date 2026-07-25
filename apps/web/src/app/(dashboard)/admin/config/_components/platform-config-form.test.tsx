import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { PlatformConfigAdminDTO } from '@/lib/platform-config/platform-config-admin';
import {
  MAX_LENGTH_ERROR,
  MIN_LENGTH_ERROR,
  WHOLE_NUMBER_MESSAGE,
  successMessage,
} from '../_actions/platform-config-schema';

// Mock the Server Action (it imports `@balo/db` / `server-only`) and Sonner (the mint-promo
// precedent). `@balo/shared/pricing` (the SSOT validity predicate) stays real.
const { mockSetMin, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockSetMin: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../_actions/set-min-consultation-length', () => ({
  setMinConsultationLength: (...a: unknown[]) => mockSetMin(...a),
}));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));

import { PlatformConfigForm } from './platform-config-form';

function dto(minConsultationMinutes = 15): PlatformConfigAdminDTO {
  return { minConsultationMinutes, billingFloorMinutes: 15 };
}

function renderForm(min = 15): ReturnType<typeof render> {
  return render(<PlatformConfigForm dto={dto(min)} />);
}

function field(): HTMLInputElement {
  return screen.getByLabelText(/minimum consultation length/i);
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /save/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetMin.mockResolvedValue({ success: true, minutes: 30 });
});

describe('PlatformConfigForm', () => {
  it('renders pre-filled with the current minimum and an accessible label (resting = disabled)', () => {
    renderForm(20);
    expect(field()).toBeInTheDocument();
    expect(field()).toHaveValue(20);
    // Pristine — nothing to save yet.
    expect(saveButton()).toBeDisabled();
  });

  it('shows the below-floor error and blocks save for a value under the billing floor', async () => {
    const user = userEvent.setup();
    renderForm(20);
    await user.clear(field());
    await user.type(field(), '10');

    expect(screen.getByRole('alert')).toHaveTextContent(MIN_LENGTH_ERROR);
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
    expect(mockSetMin).not.toHaveBeenCalled();
  });

  it('shows the distinct whole-number error for a non-integer entry and blocks save', () => {
    renderForm(20);
    // A number input drops an in-progress "15." keystroke, so set the decimal value directly.
    fireEvent.change(field(), { target: { value: '15.5' } });

    expect(screen.getByRole('alert')).toHaveTextContent(WHOLE_NUMBER_MESSAGE);
    expect(screen.getByRole('alert')).not.toHaveTextContent(MIN_LENGTH_ERROR);
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
    expect(mockSetMin).not.toHaveBeenCalled();
  });

  it('shows the above-cap error and blocks save for a value over the session cap', async () => {
    const user = userEvent.setup();
    renderForm(20);
    await user.clear(field());
    await user.type(field(), '500');

    // A minimum above the 240-minute session cap is unbookable — its own distinct message,
    // not the floor/whole-number copy.
    expect(screen.getByRole('alert')).toHaveTextContent(MAX_LENGTH_ERROR);
    expect(screen.getByRole('alert')).not.toHaveTextContent(MIN_LENGTH_ERROR);
    expect(screen.getByRole('alert')).not.toHaveTextContent(WHOLE_NUMBER_MESSAGE);
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
    expect(mockSetMin).not.toHaveBeenCalled();
  });

  it('enables save for a valid, changed value (no error shown)', async () => {
    const user = userEvent.setup();
    renderForm(15);
    await user.clear(field());
    await user.type(field(), '30');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('submits the whole-minute integer and toasts the saved value on success', async () => {
    const user = userEvent.setup();
    renderForm(15);
    await user.clear(field());
    await user.type(field(), '30');
    await user.click(saveButton());

    await waitFor(() => expect(mockSetMin).toHaveBeenCalledTimes(1));
    expect(mockSetMin).toHaveBeenCalledWith({ minutes: 30 });
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('30'))
    );
    // The success copy names the saved number.
    expect(mockToastSuccess).toHaveBeenCalledWith(successMessage(30));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('toasts the returned error message when the action fails', async () => {
    mockSetMin.mockResolvedValue({ success: false, error: 'Could not save the setting.' });
    const user = userEvent.setup();
    renderForm(15);
    await user.clear(field());
    await user.type(field(), '30');
    await user.click(saveButton());

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Could not save the setting.'));
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
