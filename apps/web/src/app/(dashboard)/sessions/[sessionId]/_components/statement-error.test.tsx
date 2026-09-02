import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { StatementError } from './statement-error';

describe('StatementError', () => {
  it('states the cause and offers a way forward, per lens', () => {
    render(<StatementError lens="client" reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load this receipt/i);
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toBeInTheDocument();
  });

  it('overrides the settings-shaped default reassurance', () => {
    render(<StatementError lens="expert" reset={vi.fn()} />);
    expect(screen.getByText(/Nothing about your earnings has changed/)).toBeInTheDocument();
    expect(screen.queryByText(/your settings are safe/i)).not.toBeInTheDocument();
  });

  it('calls reset when Try again is pressed', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<StatementError lens="client" reset={reset} />);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('LOGS NOTHING to the console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<StatementError lens="client" reset={vi.fn()} />);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
