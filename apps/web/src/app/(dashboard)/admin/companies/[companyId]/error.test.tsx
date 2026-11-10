import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from '@/test/axe';
import AdminCompanyDetailsError from './error';

describe('AdminCompanyDetailsError', () => {
  it('reassures, never renders the error or digest, and retries via reset', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'secret-digest' });

    render(<AdminCompanyDetailsError error={error} reset={reset} />);

    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret-digest/)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing was changed/i)).toBeInTheDocument();
    screen.getByRole('button', { name: /try again/i }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <AdminCompanyDetailsError error={new Error('x')} reset={() => undefined} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
