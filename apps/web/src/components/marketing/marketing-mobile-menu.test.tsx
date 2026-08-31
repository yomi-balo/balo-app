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
    onLogIn: vi.fn<() => void>(),
  };
}

describe('MarketingMobileMenu', () => {
  it('renders nothing when closed', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open={false} viewer={null} {...handlers} />);
    expect(screen.queryByText('Find experts')).not.toBeInTheDocument();
  });

  it('signed-out: shows nav items, Find an expert, Log in — no Dashboard or Messages', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open viewer={null} {...handlers} />);
    expect(screen.getByText('Find experts')).toBeInTheDocument();
    expect(screen.getByText('For experts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Find an expert' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
  });

  it('Find an expert links straight to /experts, solid (not gradient)', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open viewer={null} {...handlers} />);
    const cta = screen.getByRole('link', { name: 'Find an expert' });
    expect(cta).toHaveAttribute('href', '/experts');
    expect(cta).not.toHaveAttribute('data-variant', 'gradient');
  });

  it('signed-in: shows nav items and Dashboard — no Find an expert or Log in', () => {
    const handlers = makeHandlers();
    render(<MarketingMobileMenu open viewer={VIEWER} {...handlers} />);
    expect(screen.getByText('Find experts')).toBeInTheDocument();
    expect(screen.getByText('For experts')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Find an expert' })).not.toBeInTheDocument();
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

  it('clicking Find an expert closes the sheet (stacking guard) before the navigation link fires', async () => {
    const handlers = makeHandlers();
    const user = userEvent.setup();
    render(<MarketingMobileMenu open viewer={null} {...handlers} />);

    await user.click(screen.getByRole('link', { name: 'Find an expert' }));
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
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
