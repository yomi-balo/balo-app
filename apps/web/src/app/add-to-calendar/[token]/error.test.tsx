import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import AddToCalendarError from './error';

describe('AddToCalendarError', () => {
  it('renders the generic failure and fires reset on Try again', async () => {
    const reset = vi.fn();
    render(<AddToCalendarError error={new Error('boom')} reset={reset} />);
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('renders neither the error message nor its digest', () => {
    const error = Object.assign(new Error('signature mismatch 0xdeadbeef'), { digest: 'd-9f2c' });
    const { container } = render(<AddToCalendarError error={error} reset={vi.fn()} />);
    expect(container.textContent).not.toContain('0xdeadbeef');
    expect(container.textContent).not.toContain('d-9f2c');
  });
});
