import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatementSkeleton } from './statement-skeleton';

describe('StatementSkeleton', () => {
  it('announces itself as a labelled loading region, per lens', () => {
    const { unmount } = render(<StatementSkeleton lens="client" />);
    expect(screen.getByRole('status', { name: /Loading receipt/ })).toBeInTheDocument();
    unmount();
    render(<StatementSkeleton lens="expert" />);
    expect(screen.getByRole('status', { name: /Loading payout statement/ })).toBeInTheDocument();
  });

  it('stops every pulse under prefers-reduced-motion', () => {
    const { container } = render(<StatementSkeleton lens="client" />);
    const pulsing = container.querySelectorAll('.animate-pulse');
    expect(pulsing.length).toBeGreaterThan(0);
    for (const node of pulsing) {
      expect(node.className).toContain('motion-reduce:animate-none');
    }
  });

  it('renders no back link during loading', () => {
    const { container } = render(<StatementSkeleton lens="client" />);
    expect(container.querySelector('a')).toBeNull();
  });
});
