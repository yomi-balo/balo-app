import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import MarketingLayout from './layout';
import MarketingError from './error';

const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/experts',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: vi.fn() }),
}));

vi.mock('@/components/balo/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

function makeSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-secret-id',
    email: 'dana@northwind.example',
    firstName: 'Dana',
    lastName: 'Okafor',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-secret-id',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    expertProfileId: 'expert-profile-secret-id',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarketingLayout — signed out', () => {
  it('renders children and the signed-out header', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const ui = await MarketingLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByTestId('notification-bell')).not.toBeInTheDocument();
  });
});

describe('MarketingLayout — signed in', () => {
  it('renders children and the signed-in header', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());
    const ui = await MarketingLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
  });
});

describe('MarketingLayout — session read failure', () => {
  it('degrades to the signed-out header, still renders children, and logs a warning', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('WORKOS_COOKIE_PASSWORD missing'));
    const ui = await MarketingLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(log.warn).toHaveBeenCalledWith(
      'Marketing layout session read failed; rendering the signed-out header',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('MarketingLayout — the anti-PII-leak regression guard', () => {
  it('never serialises id, email, companyId, platformRole, or expertProfileId into the RSC payload', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());
    const ui = await MarketingLayout({ children: <p>Body</p> });
    const { container } = render(ui);

    expect(container.innerHTML).not.toContain('user-secret-id');
    expect(container.innerHTML).not.toContain('dana@northwind.example');
    expect(container.innerHTML).not.toContain('company-secret-id');
    expect(container.innerHTML).not.toContain('platformRole');
    expect(container.innerHTML).not.toContain('expert-profile-secret-id');
  });
});

describe('(marketing)/error.tsx', () => {
  it('renders the fallback and calls reset on Try again', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<MarketingError error={new Error('boom')} reset={reset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
