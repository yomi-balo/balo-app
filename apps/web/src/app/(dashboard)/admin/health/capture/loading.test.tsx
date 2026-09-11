import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('CaptureHealthLoading', () => {
  it('renders an aria-busy status region with the sr-only loading label', () => {
    render(<Loading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading capture health/i)).toBeInTheDocument();
  });

  it('renders five skeleton rows', () => {
    const { container } = render(<Loading />);
    expect(container.querySelectorAll('.divide-y > div')).toHaveLength(5);
  });
});
