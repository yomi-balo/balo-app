import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { CancelledBannerView } from '@/lib/engagement/engagement-view';

import { CancelledBanner } from './cancelled-banner';

const withReason: CancelledBannerView = {
  title: 'Engagement cancelled',
  body: 'Cancelled by Balo on 2 Jul 2026.',
  reason: 'Client and expert mutually agreed to pause the work.',
};

describe('CancelledBanner', () => {
  it('renders the title and the "Cancelled by Balo" body', () => {
    render(<CancelledBanner banner={withReason} />);
    expect(screen.getByText('Engagement cancelled')).toBeInTheDocument();
    expect(screen.getByText('Cancelled by Balo on 2 Jul 2026.')).toBeInTheDocument();
  });

  it('renders the reason as a quote when present', () => {
    render(<CancelledBanner banner={withReason} />);
    expect(
      screen.getByText(/Client and expert mutually agreed to pause the work\./)
    ).toBeInTheDocument();
  });

  it('omits the reason paragraph when reason is null', () => {
    render(<CancelledBanner banner={{ ...withReason, reason: null }} />);
    expect(screen.queryByText(/mutually agreed/)).not.toBeInTheDocument();
    expect(screen.getByText('Cancelled by Balo on 2 Jul 2026.')).toBeInTheDocument();
  });

  it('renders no action buttons (read-only)', () => {
    render(<CancelledBanner banner={withReason} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
