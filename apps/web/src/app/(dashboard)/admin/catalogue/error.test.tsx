import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminCatalogueError from './error';

/**
 * BAL-534 fix round F8 — `catalogue/error.tsx` had no test, and was 0% covered. Following the
 * `expert/calendar/error.test.tsx` precedent: renders retry copy, calls `reset()` on click, and
 * never renders the error digest or message.
 */
describe('AdminCatalogueError (BAL-534)', () => {
  it('renders retry copy and calls reset on click, never rendering the error digest', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'secret-digest-789' });

    render(<AdminCatalogueError error={error} reset={reset} />);

    expect(screen.queryByText(/secret-digest-789/)).not.toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing was changed/i)).toBeInTheDocument();

    screen.getByRole('button', { name: /try again/i }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
