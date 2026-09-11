import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminApplicationReviewNotFound from './not-found';

describe('AdminApplicationReviewNotFound (BAL-549)', () => {
  it('renders review-scoped copy and links back to the applications list', () => {
    render(<AdminApplicationReviewNotFound />);
    expect(
      screen.getByRole('heading', { name: /couldn't find that application/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to applications/i })).toHaveAttribute(
      'href',
      '/admin/applications'
    );
  });
});
