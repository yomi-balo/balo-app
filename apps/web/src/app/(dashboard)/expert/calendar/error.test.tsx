import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import ExpertCalendarError from './error';

describe('ExpertCalendarError', () => {
  it('renders retry copy and calls reset on click, never rendering the error digest', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'secret-digest-123' });

    render(<ExpertCalendarError error={error} reset={reset} />);

    expect(screen.queryByText(/secret-digest-123/)).not.toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByText(/Your bookings are safe/i)).toBeInTheDocument();

    screen.getByRole('button', { name: /try again|retry/i }).click();
    expect(reset).toHaveBeenCalled();
  });
});
