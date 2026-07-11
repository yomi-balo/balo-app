import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────

const mockReplace = vi.fn();
const mockPush = vi.fn();
// BAL-361: mutable so tests can simulate a gate-forced arrival (?forced=1&from=…).
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/auth/actions/update-timezone', () => ({
  updateTimezoneAction: vi.fn().mockResolvedValue({ success: true }),
}));

// Intent step imports completeOnboardingAction from the individual module.
const { mockCompleteOnboarding } = vi.hoisted(() => ({
  mockCompleteOnboarding: vi
    .fn()
    .mockResolvedValue({ success: true, data: { redirectTo: '/expert/apply' } }),
}));
vi.mock('@/lib/auth/actions/complete-onboarding', () => ({
  completeOnboardingAction: mockCompleteOnboarding,
}));

// Name step + company step import their actions from the barrel.
const { mockUpdateName, mockResolveCompany, mockNameWorkspace } = vi.hoisted(() => ({
  mockUpdateName: vi.fn().mockResolvedValue({ success: true }),
  mockResolveCompany: vi.fn().mockResolvedValue({ status: 'new', suggestion: 'Acme' }),
  mockNameWorkspace: vi
    .fn()
    .mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } }),
}));
vi.mock('@/lib/auth/actions', () => ({
  updateNameAction: mockUpdateName,
  resolveOnboardingCompanyAction: mockResolveCompany,
  nameWorkspaceAndCompleteAction: mockNameWorkspace,
}));

// Stub motion to render plain divs — avoids animation timing issues in tests
const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'variants',
  'transition',
  'whileHover',
  'whileTap',
  'custom',
  'layout',
]);

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_target: unknown, prop: string) => {
          const Component = React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          });
          return Component;
        },
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { OnboardingWizard } from './onboarding-wizard';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';

// ── Helpers ─────────────────────────────────────────────────────

// Standard flow (firstName provided): Welcome → Timezone → Intent → Company.
async function advanceToIntent(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /get started/i })); // Welcome → Timezone
  await user.click(screen.getByRole('button', { name: /^continue$/i })); // Timezone → Intent
  await screen.findByRole('heading', { name: /what brings you to balo/i });
}

// ── Tests ───────────────────────────────────────────────────────

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('renders Step 1 (welcome) by default when firstName is provided', () => {
    render(<OnboardingWizard firstName="Sarah" />);
    expect(screen.getByText(/Welcome to Balo, Sarah!/i)).toBeInTheDocument();
  });

  it('renders Step 1 (name) when firstName is null', () => {
    render(<OnboardingWizard firstName={null} />);
    expect(screen.getByText(/What should we call you\?/i)).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: /get started/i }));
    expect(screen.getByText(/Set Your Timezone/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText(/Welcome to Balo, Sarah!/i)).toBeInTheDocument();
  });

  it('renders progress dots with base+1 steps (4) for the standard flow', () => {
    render(<OnboardingWizard firstName="Sarah" />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '1');
    expect(progressbar).toHaveAttribute('aria-valuemax', '4');
  });

  it('renders progress dots with base+1 steps (5) when firstName is null', () => {
    render(<OnboardingWizard firstName={null} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '1');
    expect(progressbar).toHaveAttribute('aria-valuemax', '5');
  });

  it('client path advances from Intent to the Company step, then completes there', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard firstName="Sarah" authMethod="email" />);

    await advanceToIntent(user);

    // Selecting "Find an Expert" (client) advances — it does NOT complete onboarding.
    await user.click(screen.getByRole('button', { name: /find an expert/i }));
    expect(
      await screen.findByRole('heading', { name: /name your workspace/i })
    ).toBeInTheDocument();
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();

    // The Company step is the client terminal — completing it renames + redirects.
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(mockNameWorkspace).toHaveBeenCalledWith('Acme'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
  });

  it('expert path completes at Intent and never reaches the Company step', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard firstName="Sarah" authMethod="oauth_google" />);

    await advanceToIntent(user);

    await user.click(screen.getByRole('button', { name: /become an expert/i }));
    await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledWith('expert'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/expert/apply'));
    expect(mockNameWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /name your workspace/i })).not.toBeInTheDocument();
  });

  // BAL-361: landing analytics on wizard mount.
  it('emits LANDING_REACHED (forced:false) on a normal mount', () => {
    render(<OnboardingWizard firstName="Sarah" />);
    expect(track).toHaveBeenCalledWith(ONBOARDING_EVENTS.LANDING_REACHED, {
      forced: false,
      from: undefined,
    });
    expect(track).not.toHaveBeenCalledWith(ONBOARDING_EVENTS.FORCED_ON_LOGIN, expect.anything());
  });

  it('does NOT show the forced-arrival explanation on a normal mount', () => {
    render(<OnboardingWizard firstName="Sarah" />);
    expect(
      screen.queryByText(/finish setting up your account to continue/i)
    ).not.toBeInTheDocument();
  });

  it('emits LANDING_REACHED (forced:true) and FORCED_ON_LOGIN when redirected by the gate', () => {
    mockSearchParams = new URLSearchParams('forced=1&from=/dashboard');
    render(<OnboardingWizard firstName="Sarah" />);
    expect(track).toHaveBeenCalledWith(ONBOARDING_EVENTS.LANDING_REACHED, {
      forced: true,
      from: '/dashboard',
    });
    expect(track).toHaveBeenCalledWith(ONBOARDING_EVENTS.FORCED_ON_LOGIN, {
      from: '/dashboard',
    });
  });

  it('shows the forced-arrival explanation when ?forced=1 is present', () => {
    mockSearchParams = new URLSearchParams('forced=1&from=/experts');
    render(<OnboardingWizard firstName="Sarah" />);
    expect(screen.getByText(/finish setting up your account to continue/i)).toBeInTheDocument();
  });
});
