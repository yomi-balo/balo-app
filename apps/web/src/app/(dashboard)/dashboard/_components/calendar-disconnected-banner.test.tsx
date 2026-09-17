import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { CalendarDisconnectedBanner } from './calendar-disconnected-banner';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';

describe('CalendarDisconnectedBanner (BAL-566 R2)', () => {
  it('has role="status" and shows the disconnected copy', () => {
    render(<CalendarDisconnectedBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Your calendar is disconnected')).toBeInTheDocument();
    expect(
      screen.getByText('While it’s disconnected, you won’t appear in expert search.')
    ).toBeInTheDocument();
  });

  it('never promises reconnection will fix everything ("until you reconnect")', () => {
    render(<CalendarDisconnectedBanner />);
    expect(screen.queryByText(/until you reconnect/i)).toBeNull();
  });

  it('the Reconnect CTA links to the calendar settings deep link', () => {
    render(<CalendarDisconnectedBanner />);
    const cta = screen.getByRole('link', { name: /Reconnect/ });
    expect(cta).toHaveAttribute('href', '/expert/settings?tab=schedule&setup=calendar');
  });

  it('clicking Reconnect tracks calendar_connect_cta_clicked with source: dashboard_banner', async () => {
    const user = userEvent.setup();
    render(<CalendarDisconnectedBanner />);
    await user.click(screen.getByRole('link', { name: /Reconnect/ }));
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, {
      source: 'dashboard_banner',
    });
  });
});
