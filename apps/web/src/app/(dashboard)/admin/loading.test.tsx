import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

/** BAL-548 — `admin/loading.tsx` skeleton: aria-busy region, four tile skeletons, four row
 *  skeletons. Follows the `catalogue/loading.test.tsx` precedent. */
describe('AdminHomeLoading', () => {
  it('renders an aria-busy status region with four tile and four row skeletons', () => {
    const { container } = render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading the pending-actions queue/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.grid-cols-2 > div')).toHaveLength(4);
    expect(container.querySelectorAll('.divide-y > div')).toHaveLength(4);
  });
});
