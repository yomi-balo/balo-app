import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, AUTH_EVENTS } from '@/lib/analytics';
// BAL-529 §C — the mock target moves from the barrel to the concrete module `useLogout`
// imports (the D10 rule): `OnboardingSignOut` no longer calls `logoutAction` directly, it
// delegates to `useLogout()`, which imports `@/lib/auth/actions/logout`.
import { logoutAction } from '@/lib/auth/actions/logout';
import { rememberSetupIntent, readRememberedSetupIntent } from '@/lib/stripe/setup-intent-return';
import { OnboardingSignOut } from './onboarding-sign-out';

vi.mock('@/lib/auth/actions/logout', () => ({ logoutAction: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
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

  it('§C — the onboarding sign-out clears the binding too (it delegates to the one sequence)', async () => {
    rememberSetupIntent('seti_abc');
    const user = userEvent.setup();
    render(<OnboardingSignOut />);

    await user.click(screen.getByRole('button', { name: /not you\? sign out/i }));

    expect(readRememberedSetupIntent()).toBeNull();
  });
});
