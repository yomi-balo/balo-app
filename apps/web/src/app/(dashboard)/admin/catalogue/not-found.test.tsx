import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminCatalogueNotFound from './not-found';

/**
 * BAL-534 fix round F8 — `catalogue/not-found.tsx` had no test, and was 0% covered.
 */
describe('AdminCatalogueNotFound (BAL-534)', () => {
  it('renders catalogue-scoped copy and links back to the dashboard', () => {
    render(<AdminCatalogueNotFound />);
    expect(
      screen.getByRole('heading', { name: /couldn't find that catalogue entry/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });
});
