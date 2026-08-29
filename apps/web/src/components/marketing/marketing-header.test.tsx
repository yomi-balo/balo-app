import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MARKETING_EVENTS, track } from '@/lib/analytics';
import { MarketingHeader } from './marketing-header';
import type { MarketingViewer } from './marketing-viewer';

const { mockRefresh, mockOpen, state } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockOpen: vi.fn(),
  state: { pathname: '/experts' },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: mockOpen }),
}));

// ⚠ The real NotificationBell fetches /api/notifications on mount and polls every 30s.
vi.mock('@/components/balo/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

const VIEWER: MarketingViewer = {
  displayName: 'Dana Okafor',
  initials: 'DO',
  avatarUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.pathname = '/experts';
});

describe('MarketingHeader — signed out', () => {
  it('shows Log in and Get started, and hides every signed-in element', () => {
    render(<MarketingHeader viewer={null} />);
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.queryByTestId('notification-bell')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Dashboard/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Go to your dashboard/)).not.toBeInTheDocument();
  });

  it('Get started carries the gradient variant', () => {
    render(<MarketingHeader viewer={null} />);
    expect(screen.getByRole('button', { name: 'Get started' })).toHaveAttribute(
      'data-variant',
      'gradient'
    );
  });

  it('clicking Get started tracks the event and opens the signup step', async () => {
    const user = userEvent.setup();
    render(<MarketingHeader viewer={null} />);
    await user.click(screen.getByRole('button', { name: 'Get started' }));
    expect(track).toHaveBeenCalledWith(MARKETING_EVENTS.GET_STARTED_CLICKED, {
      surface: 'header',
    });
    expect(mockOpen).toHaveBeenCalledWith({
      defaultStep: 'signup',
      onSuccess: expect.any(Function),
    });
  });

  it('clicking Log in opens the auth modal without emitting any marketing event', async () => {
    const user = userEvent.setup();
    render(<MarketingHeader viewer={null} />);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(mockOpen).toHaveBeenCalledWith({ onSuccess: expect.any(Function) });
    expect(track).not.toHaveBeenCalledWith(MARKETING_EVENTS.GET_STARTED_CLICKED, expect.anything());
    expect(track).not.toHaveBeenCalledWith(MARKETING_EVENTS.DASHBOARD_CLICKED, expect.anything());
  });
});

describe('MarketingHeader — signed in', () => {
  it('shows the bell, an outline Dashboard link, and the avatar with initials', () => {
    render(<MarketingHeader viewer={VIEWER} />);
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    const dashboardLink = screen.getByRole('link', { name: /Dashboard/ });
    expect(dashboardLink).toHaveAttribute('href', '/dashboard');
    expect(dashboardLink).toHaveAttribute('data-variant', 'outline');
    expect(screen.getByLabelText('Go to your dashboard, Dana Okafor')).toBeInTheDocument();
    expect(screen.getByText('DO')).toBeInTheDocument();
  });

  it('hides Log in and Get started', () => {
    render(<MarketingHeader viewer={VIEWER} />);
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('clicking Dashboard and clicking the avatar each track marketing_dashboard_clicked', async () => {
    const user = userEvent.setup();
    render(<MarketingHeader viewer={VIEWER} />);

    await user.click(screen.getByRole('link', { name: /Dashboard/ }));
    expect(track).toHaveBeenCalledWith(MARKETING_EVENTS.DASHBOARD_CLICKED, { surface: 'header' });

    vi.clearAllMocks();
    await user.click(screen.getByLabelText('Go to your dashboard, Dana Okafor'));
    expect(track).toHaveBeenCalledWith(MARKETING_EVENTS.DASHBOARD_CLICKED, { surface: 'header' });
  });
});

describe('MarketingHeader — nav links (both variants)', () => {
  it('renders the expected hrefs and tracks a click', async () => {
    const user = userEvent.setup();
    render(<MarketingHeader viewer={null} />);
    const findExperts = screen.getByRole('link', { name: 'Find experts' });
    const forExperts = screen.getByRole('link', { name: 'For experts' });
    expect(findExperts).toHaveAttribute('href', '/experts');
    expect(forExperts).toHaveAttribute('href', '/expert/apply');

    await user.click(findExperts);
    expect(track).toHaveBeenCalledWith(MARKETING_EVENTS.NAV_CLICKED, {
      link: 'find_experts',
      surface: 'header',
    });
  });

  it('marks Find experts active on /experts', () => {
    state.pathname = '/experts';
    render(<MarketingHeader viewer={null} />);
    expect(screen.getByRole('link', { name: 'Find experts' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('marks Find experts active on a nested expert profile', () => {
    state.pathname = '/experts/dana';
    render(<MarketingHeader viewer={null} />);
    expect(screen.getByRole('link', { name: 'Find experts' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('marks no link active off the experts routes', () => {
    state.pathname = '/dashboard';
    render(<MarketingHeader viewer={null} />);
    expect(screen.getByRole('link', { name: 'Find experts' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'For experts' })).not.toHaveAttribute('aria-current');
  });
});

describe('MarketingHeader — accessibility', () => {
  it('has no accessibility violations, signed out', async () => {
    const { container } = render(<MarketingHeader viewer={null} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations, signed in', async () => {
    const { container } = render(<MarketingHeader viewer={VIEWER} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
