import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';

// redirect() throws in real Next (NEXT_REDIRECT) to short-circuit the render —
// mirror that so control flow stops exactly where it would in production.
const { mockRedirect, mockGetCurrentUser, mockCheckSessionDrift } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  }),
  mockGetCurrentUser: vi.fn(),
  mockCheckSessionDrift: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/auth/session-sync', () => ({ checkSessionDrift: mockCheckSessionDrift }));
vi.mock('./_components/onboarding-wizard', () => ({
  OnboardingWizard: (): React.JSX.Element => <div>wizard rendered</div>,
}));

import OnboardingPage from './page';

function buildUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'test@example.com',
    firstName: 'Sarah',
    lastName: null,
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: false,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Workspace',
    companyRole: 'owner',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OnboardingPage', () => {
  it('redirects to session-sync when drift is detected', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'sync-needed' });
    await expect(OnboardingPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/api/auth/session-sync?returnTo=/dashboard');
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('redirects to /login when there is no user', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(OnboardingPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });

  it('redirects a completed user to /dashboard', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    mockGetCurrentUser.mockResolvedValue(buildUser({ onboardingCompleted: true }));
    await expect(OnboardingPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders the wizard for a genuinely un-onboarded user (no drift)', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    mockGetCurrentUser.mockResolvedValue(buildUser({ onboardingCompleted: false }));
    render(await OnboardingPage());
    expect(screen.getByText('wizard rendered')).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
