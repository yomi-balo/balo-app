import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import { track, EXPERT_SETUP_EVENTS } from '@/lib/analytics';
import type { LiveStatusView } from '@/lib/expert/live-status-view';
import { LiveStatusPill } from './live-status-pill';

function view(overrides: Partial<LiveStatusView> = {}): LiveStatusView {
  return { state: 'live', fixItem: null, publicProfileHref: '/experts/dana', ...overrides };
}

describe('LiveStatusPill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      'live',
      'Live',
      "You're live on the marketplace",
      'Clients can find you in search and book you.',
    ],
    [
      'paused',
      'Bookings paused',
      'Bookings are paused',
      "You still appear in search, but clients can't book you until your calendar is reconnected.",
    ],
    [
      'away',
      'Not taking work',
      "You're not taking on new work",
      'You still appear in search, but clients are offered a similar expert instead of booking you.',
    ],
    [
      'not_listed',
      'Not listed',
      "You're not in search right now",
      "Clients can't find you until your calendar is reconnected.",
    ],
  ] as const)('%s renders its design copy', async (state, pill, title, body) => {
    const user = userEvent.setup();
    render(
      <LiveStatusPill
        status={view({
          state,
          fixItem: state === 'not_listed' ? 'calendar' : null,
          publicProfileHref: null,
        })}
        variant="sidebar"
      />
    );
    const trigger = screen.getByRole('button', { name: pill });
    expect(trigger).toHaveAttribute('data-live-state', state);
    await user.click(trigger);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
  });

  it.each([
    ['paused', 'Reconnect calendar', '/expert/settings?tab=schedule&setup=calendar'],
    ['away', 'Change availability', '/expert/settings?tab=schedule'],
  ] as const)('%s primary action links to %s', async (state, label, href) => {
    const user = userEvent.setup();
    render(<LiveStatusPill status={view({ state })} variant="sidebar" />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
  });

  it('live has no primary action but offers the public profile in a new tab', async () => {
    const user = userEvent.setup();
    render(<LiveStatusPill status={view()} variant="sidebar" />);
    await user.click(screen.getByRole('button'));
    const link = screen.getByRole('link', { name: /View public profile/ });
    expect(link).toHaveAttribute('href', '/experts/dana');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('offers no profile link without an href', async () => {
    const user = userEvent.setup();
    render(
      <LiveStatusPill
        status={view({ state: 'not_listed', fixItem: 'calendar', publicProfileHref: null })}
        variant="sidebar"
      />
    );
    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('link', { name: /View public profile/ })).not.toBeInTheDocument();
  });

  it('names a non-calendar fix item for not_listed', async () => {
    const user = userEvent.setup();
    render(
      <LiveStatusPill
        status={view({ state: 'not_listed', fixItem: 'payouts', publicProfileHref: null })}
        variant="sidebar"
      />
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('link', { name: 'Set up payouts' })).toHaveAttribute(
      'href',
      '/expert/settings?tab=payouts&setup=payouts'
    );
  });

  it('tracks open, then each action with onNavigate in the sheet', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <LiveStatusPill status={view({ state: 'paused' })} variant="sheet" onNavigate={onNavigate} />
    );
    await user.click(screen.getByRole('button'));
    expect(track).toHaveBeenCalledWith(EXPERT_SETUP_EVENTS.LIVE_STATUS_OPENED, {
      state: 'paused',
    });

    await user.click(screen.getByRole('link', { name: 'Reconnect calendar' }));
    expect(track).toHaveBeenCalledWith(EXPERT_SETUP_EVENTS.LIVE_STATUS_ACTION, {
      state: 'paused',
      action: 'reconnect_calendar',
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('tracks the public profile action', async () => {
    const user = userEvent.setup();
    render(<LiveStatusPill status={view()} variant="sidebar" />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('link', { name: /View public profile/ }));
    expect(track).toHaveBeenCalledWith(EXPERT_SETUP_EVENTS.LIVE_STATUS_ACTION, {
      state: 'live',
      action: 'view_public_profile',
    });
  });

  it('does not close the sheet for the new-tab public profile link', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<LiveStatusPill status={view()} variant="sheet" onNavigate={onNavigate} />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('link', { name: /View public profile/ }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('gives sheet popover actions a 44px tap target, not the sidebar ones', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <LiveStatusPill status={view({ state: 'paused' })} variant="sheet" />
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('link', { name: 'Reconnect calendar' })).toHaveClass('min-h-[44px]');
    unmount();
    render(<LiveStatusPill status={view({ state: 'paused' })} variant="sidebar" />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('link', { name: 'Reconnect calendar' })).not.toHaveClass(
      'min-h-[44px]'
    );
  });

  it('gives the sheet trigger a 44px tap target', () => {
    render(<LiveStatusPill status={view()} variant="sheet" />);
    expect(screen.getByRole('button')).toHaveClass('min-h-[44px]');
  });

  it('has no accessibility violations with the popover open', async () => {
    const user = userEvent.setup();
    render(<LiveStatusPill status={view({ state: 'paused' })} variant="sidebar" />);
    await user.click(screen.getByRole('button'));
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});
