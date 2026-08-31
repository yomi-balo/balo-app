import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsError from './error';
import BillingLoading from './billing/loading';

describe('SettingsError', () => {
  it('renders an error message and calls reset on retry', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<SettingsError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('billing/loading.tsx', () => {
  it('renders an accessible loading affordance', () => {
    render(<BillingLoading />);
    expect(screen.getByLabelText('Loading wallet balance')).toBeInTheDocument();
  });
});
