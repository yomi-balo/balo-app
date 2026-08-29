import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { MarketingNavLink } from '@/lib/analytics';
import { MarketingMobileMenu } from './marketing-mobile-menu';
import type { MarketingViewer } from './marketing-viewer';

const VIEWER: MarketingViewer = {
  displayName: 'Dana Okafor',
  initials: 'DO',
  avatarUrl: null,
};

function makeHandlers() {
  return {
    onOpenChange: vi.fn<(open: boolean) => void>(),
    onNavigate: vi.fn<(link: MarketingNavLink) => void>(),
    onDashboard: vi.fn<() => void>(),
    onGetStarted: vi.fn<() => void>(),
    onLogIn: vi.fn<() => void>(),
  };
}

describe('MarketingMobileMenu', () => {
  it('renders nothing when closed', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open={false} viewer={null} {...handlers} />);
    expect(screen.queryByText('Find experts')).not.toBeInTheDocument();
  });

  it('signed-out: shows nav items, Get started, Log in — no Dashboard or Messages', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open viewer={null} {...handlers} />);
    expect(screen.getByText('Find experts')).toBeInTheDocument();
    expect(screen.getByText('For experts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
  });

  it('signed-in: shows nav items and Dashboard — no Get started or Log in', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open viewer={VIEWER} {...handlers} />);
    expect(screen.getByText('Find experts')).toBeInTheDocument();
    expect(screen.getByText('For experts')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it('clicking a nav item closes the sheet and reports the navigation', async () => {
    const handlers = makeHandlers();
    const user = userEvent.setup();
    render(<MarketingMobileMenu open viewer={null} {...handlers} />);

    await user.click(screen.getByText('Find experts'));
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(handlers.onNavigate).toHaveBeenCalledWith('find_experts');
  });

  it('clicking Get started closes the sheet BEFORE opening the auth modal (stacking guard)', async () => {
    const handlers = makeHandlers();
    const order: string[] = [];
    handlers.onOpenChange.mockImplementation(() => order.push('close'));
    handlers.onGetStarted.mockImplementation(() => order.push('getStarted'));
    const user = userEvent.setup();
    render(<MarketingMobileMenu open viewer={null} {...handlers} />);

    await user.click(screen.getByRole('button', { name: 'Get started' }));
    expect(order).toEqual(['close', 'getStarted']);
  });

  it('clicking Dashboard closes the sheet and reports the click', async () => {
    const handlers = makeHandlers();
    const user = userEvent.setup();
    render(<MarketingMobileMenu open viewer={VIEWER} {...handlers} />);

    await user.click(screen.getByText('Dashboard'));
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(handlers.onDashboard).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations when open', async () => {
    const handlers = makeHandlers();
    const { baseElement } = render(<MarketingMobileMenu open viewer={null} {...handlers} />);
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
