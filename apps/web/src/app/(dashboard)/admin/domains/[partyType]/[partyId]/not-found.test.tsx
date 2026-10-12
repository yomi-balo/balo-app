import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminPartyDomainsNotFound from './not-found';

describe('AdminPartyDomainsNotFound', () => {
  it('links back to Lookup', () => {
    render(<AdminPartyDomainsNotFound />);
    expect(screen.getByRole('heading', { name: /couldn't find that party/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to lookup/i })).toHaveAttribute(
      'href',
      '/admin/lookup'
    );
  });
});
