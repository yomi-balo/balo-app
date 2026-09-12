import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import AdminApplicationsNotFound from './not-found';

describe('AdminApplicationsNotFound (BAL-549)', () => {
  it('renders applications-scoped copy and links back to the dashboard', () => {
    render(<AdminApplicationsNotFound />);
    expect(
      screen.getByRole('heading', { name: /couldn't find the applications queue/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });
});
