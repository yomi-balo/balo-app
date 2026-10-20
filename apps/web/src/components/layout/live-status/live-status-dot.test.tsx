import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LiveStatusDot } from './live-status-dot';

describe('LiveStatusDot', () => {
  it('renders a decorative dot with the state token and the ring class', () => {
    const { container } = render(<LiveStatusDot state="live" ringClassName="ring-sidebar" />);
    const dot = container.querySelector('[data-live-dot="live"]');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveClass('bg-success', 'ring-sidebar');
  });

  it('stays silent when announce is off', () => {
    const { queryByText } = render(
      <LiveStatusDot state="live" ringClassName="ring-sidebar" announce={false} />
    );
    expect(queryByText(/Marketplace status/)).toBeNull();
  });

  it('announces the status to screen readers', () => {
    const { getByText } = render(<LiveStatusDot state="paused" ringClassName="ring-background" />);
    expect(getByText('Marketplace status: Bookings paused')).toHaveClass('sr-only');
  });
});
