import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Sentry from '@sentry/nextjs';
import DashboardError from './error';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

describe('DashboardError', () => {
  it('shows the error state, retries via reset and reports to Sentry', async () => {
    const reset = vi.fn();
    const error = new Error('boom');
    const user = userEvent.setup();
    render(<DashboardError error={error} reset={reset} />);

    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load this page");
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
