import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────

const mockReplace = vi.fn();
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth/actions/update-timezone', () => ({
  updateTimezoneAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/lib/auth/actions/complete-onboarding', () => ({
  completeOnboardingAction: vi.fn().mockResolvedValue({
    success: true,
    data: { redirectTo: '/dashboard' },
  }),
}));

// Stub motion to render plain divs — avoids animation timing issues in tests
vi.mock('motion/react', () => {
  const React = require('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_target: unknown, prop: string) => {
          return React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
            const {
              initial: _i,
              animate: _a,
              exit: _e,
              variants: _v,
              transition: _t,
              whileHover: _wh,
              whileTap: _wt,
              custom: _c,
              layout: _l,
              ...rest
            } = props;
            return React.createElement(prop, { ...rest, ref });
          });
        },
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { OnboardingWizard } from './onboarding-wizard';

// ── Tests ───────────────────────────────────────────────────────

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Step 1 (welcome) by default', () => {
    render(<OnboardingWizard firstName="Sarah" />);
    expect(screen.getByText(/Welcome to Balo, Sarah!/i)).toBeInTheDocument();
  });

  it('shows generic greeting when firstName is null', () => {
    render(<OnboardingWizard firstName={null} />);
    expect(screen.getByText(/Welcome to Balo!/i)).toBeInTheDocument();
  });

  it('advances to Step 2 when "Get Started" is clicked', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard firstName="Sarah" />);

    await user.click(screen.getByRole('button', { name: /get started/i }));
    expect(screen.getByText(/Set Your Timezone/i)).toBeInTheDocument();
  });

  it('goes back to Step 1 from Step 2 when "Back" is clicked', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard firstName="Sarah" />);

    // Advance to Step 2
    await user.click(screen.getByRole('button', { name: /get started/i }));
    expect(screen.getByText(/Set Your Timezone/i)).toBeInTheDocument();

    // Go back to Step 1
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText(/Welcome to Balo, Sarah!/i)).toBeInTheDocument();
  });

  it('renders progress dots with correct aria attributes', () => {
    render(<OnboardingWizard firstName="Sarah" />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '1');
    expect(progressbar).toHaveAttribute('aria-valuemax', '3');
  });
});
