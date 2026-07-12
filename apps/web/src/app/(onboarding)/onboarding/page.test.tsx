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
vi.mock('./_components/onboarding-reminder-click-tracker', () => ({
  OnboardingReminderClickTracker: ({
    cadenceStep,
    domainClass,
  }: {
    cadenceStep: number;
    domainClass: string;
  }): React.JSX.Element => (
    <div data-testid="reminder-tracker" data-step={cadenceStep} data-domain={domainClass} />
  ),
}));

import OnboardingPage from './page';

type SearchParams = Record<string, string | string[] | undefined>;

function runPage(searchParams: SearchParams = {}): Promise<React.JSX.Element> {
  return OnboardingPage({ searchParams });
}

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
    await expect(runPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/api/auth/session-sync?returnTo=/dashboard');
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('redirects to /login when there is no user', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(runPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });

  it('redirects a completed user to /dashboard', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    mockGetCurrentUser.mockResolvedValue(buildUser({ onboardingCompleted: true }));
    await expect(runPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders the wizard for a genuinely un-onboarded user (no drift)', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    mockGetCurrentUser.mockResolvedValue(buildUser({ onboardingCompleted: false }));
    render(await runPage());
    expect(screen.getByText('wizard rendered')).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  describe('BAL-374 reminder-click tracking', () => {
    beforeEach(() => {
      mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
    });

    it('does NOT render the tracker for a normal (non-reminder) landing', async () => {
      mockGetCurrentUser.mockResolvedValue(buildUser());
      render(await runPage());
      expect(screen.queryByTestId('reminder-tracker')).not.toBeInTheDocument();
    });

    it('renders the tracker with the parsed step + corporate domain class from the CTA', async () => {
      mockGetCurrentUser.mockResolvedValue(buildUser({ email: 'founder@acme.com' }));
      render(await runPage({ src: 'onboarding_reminder', step: '2' }));
      const tracker = screen.getByTestId('reminder-tracker');
      expect(tracker).toHaveAttribute('data-step', '2');
      expect(tracker).toHaveAttribute('data-domain', 'corporate');
    });

    it('classifies a freemail signup as freemail', async () => {
      mockGetCurrentUser.mockResolvedValue(buildUser({ email: 'someone@gmail.com' }));
      render(await runPage({ src: 'onboarding_reminder', step: '3' }));
      const tracker = screen.getByTestId('reminder-tracker');
      expect(tracker).toHaveAttribute('data-step', '3');
      expect(tracker).toHaveAttribute('data-domain', 'freemail');
    });

    it('defaults an absent/invalid step to 1', async () => {
      mockGetCurrentUser.mockResolvedValue(buildUser({ email: 'founder@acme.com' }));
      render(await runPage({ src: 'onboarding_reminder' }));
      expect(screen.getByTestId('reminder-tracker')).toHaveAttribute('data-step', '1');
    });
  });
});
