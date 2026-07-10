import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { JoinResultView } from './join-result-view';

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const { mockCompleteOnboarding } = vi.hoisted(() => ({
  mockCompleteOnboarding: vi.fn(),
}));

vi.mock('@/lib/auth/actions', () => ({
  completeOnboardingAction: mockCompleteOnboarding,
}));

// ── Helpers ─────────────────────────────────────────────────────

type Props = React.ComponentProps<typeof JoinResultView>;

function renderView(overrides: Partial<Props> = {}) {
  const props: Props = {
    status: 'approved',
    companyName: 'Northwind',
    alreadyOnboarded: false,
    ...overrides,
  };
  render(<JoinResultView {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompleteOnboarding.mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } });
});

// ── Tests ───────────────────────────────────────────────────────

describe('JoinResultView', () => {
  it('renders the approved terminal phase (initialPhase wiring)', async () => {
    renderView({ status: 'approved' });
    expect(
      await screen.findByRole('heading', { name: /you're in — welcome to northwind/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to northwind/i })).toBeInTheDocument();
  });

  it('renders the declined terminal phase (initialPhase wiring)', async () => {
    renderView({ status: 'declined' });
    expect(
      await screen.findByRole('heading', { name: /set up your own workspace/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create my own company/i })).toBeInTheDocument();
  });

  it('approved "Continue" completes onboarding (client) then navigates when NOT already onboarded', async () => {
    const user = userEvent.setup();
    renderView({ status: 'approved', alreadyOnboarded: false });

    await user.click(screen.getByRole('button', { name: /continue to northwind/i }));

    await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledWith('client'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
  });

  it('approved "Continue" navigates WITHOUT completing onboarding when already onboarded', async () => {
    const user = userEvent.setup();
    renderView({ status: 'approved', alreadyOnboarded: true });

    await user.click(screen.getByRole('button', { name: /continue to northwind/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
  });

  it('declined "Create my own company" finishes onboarding then navigates', async () => {
    const user = userEvent.setup();
    renderView({ status: 'declined', alreadyOnboarded: false });

    await user.click(screen.getByRole('button', { name: /create my own company/i }));

    await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledWith('client'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
  });

  it('shows an inline error and does NOT navigate when completion fails (fails closed)', async () => {
    const user = userEvent.setup();
    mockCompleteOnboarding.mockResolvedValue({ success: false, error: 'Something went wrong.' });
    renderView({ status: 'approved', alreadyOnboarded: false });

    await user.click(screen.getByRole('button', { name: /continue to northwind/i }));

    await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(mockPush).not.toHaveBeenCalled();
  });
});
