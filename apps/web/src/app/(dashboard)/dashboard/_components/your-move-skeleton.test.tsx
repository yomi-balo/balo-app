import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { YourMoveSkeleton } from './your-move-skeleton';

describe('YourMoveSkeleton', () => {
  it('renders the busy rail skeleton', () => {
    render(<YourMoveSkeleton />);
    expect(screen.getByLabelText('Loading your move')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders an aria-hidden track skeleton with five nodes', () => {
    const { container } = render(<YourMoveSkeleton />);
    const sections = container.querySelectorAll('section');
    expect(sections).toHaveLength(2);
    const trackSkeleton = sections[1];
    expect(trackSkeleton).toHaveAttribute('aria-hidden', 'true');
    expect(trackSkeleton?.querySelectorAll('.rounded-full')).toHaveLength(5);
  });
});
