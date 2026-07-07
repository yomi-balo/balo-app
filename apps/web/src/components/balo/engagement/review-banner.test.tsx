import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { ReviewBannerView } from '@/lib/engagement/engagement-view';

import { ReviewBanner } from './review-banner';

const withCountdown: ReviewBannerView = {
  title: 'Priya @ CloudPeak Consulting has marked the project complete',
  body: 'Review the delivery plan below, then accept the project or request changes.',
  countdown: { autoOnDate: '11 Jul 2026', daysRemaining: 5, autoInLabel: '5 days' },
};

describe('ReviewBanner', () => {
  it('renders the title and body copy from the view', () => {
    render(<ReviewBanner banner={withCountdown} />);
    expect(
      screen.getByText('Priya @ CloudPeak Consulting has marked the project complete')
    ).toBeInTheDocument();
    expect(screen.getByText(/Review the delivery plan below/)).toBeInTheDocument();
  });

  it('renders the informational auto-accept pill when a countdown is present', () => {
    render(<ReviewBanner banner={withCountdown} />);
    expect(screen.getByText('Auto-accepts in 5 days')).toBeInTheDocument();
  });

  it('omits the countdown pill when countdown is null', () => {
    render(<ReviewBanner banner={{ ...withCountdown, countdown: null }} />);
    expect(screen.queryByText(/Auto-accepts in/)).not.toBeInTheDocument();
  });

  it('renders no action buttons (read-only)', () => {
    render(<ReviewBanner banner={withCountdown} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
