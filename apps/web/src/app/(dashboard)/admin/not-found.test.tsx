import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminNotFound from './not-found';

/**
 * BAL-534 fix round F8 — `admin/not-found.tsx` had no test, and was 0% covered.
 */
describe('AdminNotFound (BAL-534)', () => {
  it('renders admin-scoped copy and links back to the admin catalogue', () => {
    render(<AdminNotFound />);
    expect(screen.getByRole('heading', { name: /admin page doesn't exist/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to admin/i })).toHaveAttribute(
      'href',
      '/admin/catalogue'
    );
  });
});
