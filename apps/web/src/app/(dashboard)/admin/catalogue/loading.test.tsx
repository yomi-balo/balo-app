import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

/**
 * BAL-534 fix round F8 — `catalogue/loading.tsx` had no test, and was 0% covered. Following the
 * `settings/team/loading.test.tsx` precedent.
 */
describe('AdminCatalogueLoading (BAL-534)', () => {
  it('renders an aria-busy status region with six skeleton rows', () => {
    const { container } = render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading the catalogue/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.divide-y > div')).toHaveLength(6);
  });
});
