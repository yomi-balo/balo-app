import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import CallNowLandingError from './error';

const ERROR = Object.assign(new Error('postgres connection refused at 10.0.0.4'), {
  digest: 'abc123digest',
});

describe('CallNowLandingError', () => {
  it('renders a retry control and a way back to the cases', () => {
    render(<CallNowLandingError error={ERROR} reset={vi.fn()} />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to your cases/i })).toHaveAttribute(
      'href',
      '/cases'
    );
  });

  it('never renders the error message or its digest', () => {
    const { container } = render(<CallNowLandingError error={ERROR} reset={vi.fn()} />);

    expect(container.innerHTML).not.toContain('postgres');
    expect(container.innerHTML).not.toContain('abc123digest');
  });

  it('calls reset when retried', async () => {
    const reset = vi.fn();
    render(<CallNowLandingError error={ERROR} reset={reset} />);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CallNowLandingError error={ERROR} reset={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
