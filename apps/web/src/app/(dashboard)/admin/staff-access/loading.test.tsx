import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('StaffAccessLoading (BAL-561)', () => {
  it('renders an aria-busy status region with the two-column skeleton', () => {
    const { container } = render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading staff access/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.lg\\:grid-cols-\\[300px_1fr\\]')).toHaveLength(1);
  });
});
