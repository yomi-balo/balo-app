import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
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

  // BAL-534 review round 2 (Qodo #11) — the retry control is an interactive, user-facing
  // surface, so it carries the same axe check the catalogue list does.
  it('has no accessibility violations', async () => {
    const { container } = render(
      <AdminCatalogueError
        error={Object.assign(new Error('boom'), { digest: 'd' })}
        reset={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
