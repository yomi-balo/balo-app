import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import OnboardingLoading from './loading';

vi.mock('@/lib/auth/actions/logout', () => ({ logoutAction: vi.fn() }));

describe('Onboarding loading state', () => {
  it('keeps the frame, and its sign-out exit, while the wizard streams in', () => {
    render(<OnboardingLoading />);
    expect(screen.getByRole('img', { name: 'Balo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /not you\? sign out/i })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
