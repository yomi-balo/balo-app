import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import { OnboardingFrame } from './onboarding-frame';

vi.mock('@/lib/auth/actions/logout', () => ({ logoutAction: vi.fn() }));

describe('OnboardingFrame', () => {
  it('renders the wordmark and the sign-out exit in the header', () => {
    render(
      <OnboardingFrame>
        <p>step body</p>
      </OnboardingFrame>
    );
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('img', { name: 'Balo' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: /not you\? sign out/i })).toBeEnabled();
  });

  it('renders children inside the main region', () => {
    render(
      <OnboardingFrame>
        <p>step body</p>
      </OnboardingFrame>
    );
    expect(within(screen.getByRole('main')).getByText('step body')).toBeInTheDocument();
  });

  it('places the progress slot in the header when given', () => {
    render(
      <OnboardingFrame progress={<div data-testid="progress-slot" />}>
        <p>step body</p>
      </OnboardingFrame>
    );
    expect(within(screen.getByRole('banner')).getByTestId('progress-slot')).toBeInTheDocument();
  });

  it('omits the progress slot when none is given', () => {
    const { container } = render(
      <OnboardingFrame>
        <p>step body</p>
      </OnboardingFrame>
    );
    expect(container.querySelector('header')?.children).toHaveLength(2);
  });
});
