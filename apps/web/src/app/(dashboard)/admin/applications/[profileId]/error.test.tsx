import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import AdminApplicationReviewError from './error';

describe('AdminApplicationReviewError (BAL-549)', () => {
  it('renders retry copy and calls reset on click, never rendering the error digest', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'secret-digest-789' });

    render(<AdminApplicationReviewError error={error} reset={reset} />);

    expect(screen.queryByText(/secret-digest-789/)).not.toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing was changed/i)).toBeInTheDocument();

    screen.getByRole('button', { name: /try again/i }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <AdminApplicationReviewError
        error={Object.assign(new Error('boom'), { digest: 'd' })}
        reset={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
