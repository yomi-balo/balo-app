import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';

vi.mock('motion/react', async () => {
  const React = await import('react');
  const MOTION_PROPS = new Set(['variants', 'initial', 'animate']);
  const passthrough = (tag: string) =>
    function Mock(props: Record<string, unknown>) {
      const rest = Object.fromEntries(
        Object.entries(props).filter(([key]) => !MOTION_PROPS.has(key))
      );
      return React.createElement(tag, rest);
    };
  return {
    motion: {
      section: passthrough('section'),
      div: passthrough('div'),
      h3: passthrough('h3'),
      p: passthrough('p'),
    },
  };
});

const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
}));

const mockMarkSeen = vi.fn();
vi.mock('../_actions/mark-live-celebration-seen', () => ({
  markLiveCelebrationSeenAction: () => mockMarkSeen(),
}));

import { CelebrationCard } from './celebration-card';

describe('CelebrationCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkSeen.mockResolvedValue({ stamped: true });
  });

  it('stamps the celebration as seen once on mount', () => {
    render(<CelebrationCard publicProfileHref="/experts/dana" />);
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
  });

  it('links to the public profile in a new tab', () => {
    render(<CelebrationCard publicProfileHref="/experts/dana" />);
    const link = screen.getByRole('link', { name: /View your public profile/ });
    expect(link).toHaveAttribute('href', '/experts/dana');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits the button without a public profile', () => {
    render(<CelebrationCard publicProfileHref={null} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText("You're live on the marketplace!")).toBeInTheDocument();
  });

  it('says where the status sits from now on', () => {
    render(<CelebrationCard publicProfileHref={null} />);
    expect(
      screen.getByText('From now on, your status sits next to your name.')
    ).toBeInTheDocument();
  });

  it('reports a rejected stamp to Sentry without breaking the card', async () => {
    const error = new Error('Unauthorized');
    mockMarkSeen.mockRejectedValue(error);
    render(<CelebrationCard publicProfileHref={null} />);
    await waitFor(() => expect(mockCapture).toHaveBeenCalledWith(error));
  });

  it('is a labelled region and flags the new-tab link', () => {
    render(<CelebrationCard publicProfileHref="/experts/dana" />);
    expect(
      screen.getByRole('region', { name: "You're live on the marketplace" })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /opens in new tab/ })).toBeInTheDocument();
  });
});
