import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, AUTH_EVENTS } from '@/lib/analytics';
import { logoutAction } from '@/lib/auth/actions';
import { OnboardingSignOut } from './onboarding-sign-out';

vi.mock('@/lib/auth/actions', () => ({ logoutAction: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OnboardingSignOut', () => {
  it('renders an accessible, enabled sign-out button by default', () => {
    render(<OnboardingSignOut />);
    expect(screen.getByRole('button', { name: /not you\? sign out/i })).toBeEnabled();
  });

  it('tracks logout and invokes the sign-out action on click', async () => {
    const user = userEvent.setup();
    render(<OnboardingSignOut />);

    await user.click(screen.getByRole('button', { name: /not you\? sign out/i }));

    expect(track).toHaveBeenCalledWith(AUTH_EVENTS.LOGOUT_COMPLETED, {});
    expect(logoutAction).toHaveBeenCalledTimes(1);
  });
});
