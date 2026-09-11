import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('AdminApplicationReviewLoading (BAL-549)', () => {
  it('renders an aria-busy status region', () => {
    render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading the application/i)).toBeInTheDocument();
  });
});
