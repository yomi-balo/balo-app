import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('AdminApplicationsLoading (BAL-549)', () => {
  it('renders an aria-busy status region with four skeleton rows', () => {
    const { container } = render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading applications/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.divide-y > div')).toHaveLength(4);
  });
});
