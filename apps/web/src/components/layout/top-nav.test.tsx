import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('./sidebar-context', () => ({
  useSidebar: () => ({ setMobileOpen: vi.fn() }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

// Mock NotificationBell to avoid fetch calls
vi.mock('@/components/balo/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

import { TopNav } from './top-nav';

// ── Tests ───────────────────────────────────────────────────────

describe('TopNav', () => {
  it('renders the page title based on pathname', () => {
    render(<TopNav />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders the NotificationBell component', () => {
    render(<TopNav />);
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
  });

  it('does not render mobile menu button on desktop', () => {
    render(<TopNav />);
    expect(screen.queryByRole('button', { name: 'Open navigation menu' })).not.toBeInTheDocument();
  });
});
