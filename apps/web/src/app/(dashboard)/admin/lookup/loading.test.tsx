import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('AdminLookupLoading (BAL-551)', () => {
  it('renders an aria-busy status region with the sr-only loading label', () => {
    render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading lookup/i)).toBeInTheDocument();
  });

  it('renders three skeleton result rows', () => {
    const { container } = render(<Loading />);
    expect(container.querySelectorAll('.divide-y > div')).toHaveLength(3);
  });

  it('renders six chip skeletons (BAL-555 — SIX chips, not five)', () => {
    const { container } = render(<Loading />);
    expect(container.querySelectorAll('.rounded-full')).toHaveLength(6);
  });
});
