import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('AdminCompanyDetailsLoading', () => {
  it('renders an aria-busy status region', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading the company details/i)).toBeInTheDocument();
  });
});
