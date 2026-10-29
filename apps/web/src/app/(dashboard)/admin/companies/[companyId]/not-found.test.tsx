import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminCompanyDetailsNotFound from './not-found';

describe('AdminCompanyDetailsNotFound', () => {
  it('links back to Lookup', () => {
    render(<AdminCompanyDetailsNotFound />);
    expect(
      screen.getByRole('heading', { name: /couldn't find that company/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to lookup/i })).toHaveAttribute(
      'href',
      '/admin/lookup'
    );
  });
});
