import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, AUTH_EVENTS, ONBOARDING_EVENTS } from '@/lib/analytics';
import type { AuthMethodSignal } from '@/lib/auth/auth-method';

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const { mockResolve, mockComplete } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockComplete: vi.fn(),
}));

vi.mock('@/lib/auth/actions', () => ({
  resolveOnboardingCompanyAction: mockResolve,
  nameWorkspaceAndCompleteAction: mockComplete,
}));

import { CompanyStep } from './company-step';

// ── Helpers ─────────────────────────────────────────────────────

function renderStep(authMethod: AuthMethodSignal = 'email') {
  return render(
    <CompanyStep authMethod={authMethod} timezone="Europe/London" stepNumber={5} onBack={vi.fn()} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockComplete.mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } });
});

// ── Tests ───────────────────────────────────────────────────────

describe('CompanyStep', () => {
  it('shows the resolving spinner while the workspace identity resolves', () => {
    mockResolve.mockReturnValue(new Promise(() => {})); // never settles
    renderStep();
    expect(screen.getByText(/setting up your workspace/i)).toBeInTheDocument();
  });

  it('renders the create form prefilled with the email-derived suggestion', async () => {
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(screen.getByLabelText(/company name/i)).toHaveValue('Acme');
    expect(screen.getByText(/we suggested this from your email/i)).toBeInTheDocument();
  });

  it('renders the blocked-domain helper copy and an empty field', async () => {
    mockResolve.mockResolvedValue({ status: 'blocked', suggestion: '' });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
    expect(screen.getByText(/tell us your company or team name/i)).toBeInTheDocument();
  });

  it('shows a required error and does not submit when the name is empty', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'blocked', suggestion: '' });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText(/enter a name for your workspace/i)).toBeInTheDocument();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each<AuthMethodSignal>(['email', 'oauth_google'])(
    'completes the create branch and fires analytics for auth_method=%s',
    async (authMethod) => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
      renderStep(authMethod);

      await screen.findByRole('heading', { name: /name your workspace/i });
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
      expect(mockComplete).toHaveBeenCalledWith('Acme');
      expect(track).toHaveBeenCalledWith(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
        domain_type: 'new',
        prefill_used: true,
        prefill_edited: false,
        auth_method: authMethod,
      });
      expect(track).toHaveBeenCalledWith(
        ONBOARDING_EVENTS.COMPLETED,
        expect.objectContaining({ intent: 'client', timezone: 'Europe/London' })
      );
    }
  );

  it('marks prefill_edited when the user changes the suggested name', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    renderStep();

    const input = await screen.findByLabelText(/company name/i);
    await user.clear(input);
    await user.type(input, 'Acme Corp');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith('Acme Corp'));
    expect(track).toHaveBeenCalledWith(
      AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED,
      expect.objectContaining({ prefill_used: true, prefill_edited: true })
    );
  });

  it('reports domain_type blocked with prefill_used false for a blocked domain', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'blocked', suggestion: '' });
    renderStep();

    const input = await screen.findByLabelText(/company name/i);
    await user.type(input, 'My Team');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith('My Team'));
    expect(track).toHaveBeenCalledWith(
      AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED,
      expect.objectContaining({
        domain_type: 'blocked',
        prefill_used: false,
        prefill_edited: false,
      })
    );
  });

  it('shows a retryable error banner when the save fails and keeps the form editable', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    mockComplete.mockResolvedValue({
      success: false,
      error: "We couldn't save that just now. Please try again.",
    });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save that just now/i);
    // Form stays editable (retryable).
    expect(screen.getByLabelText(/company name/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('renders the dormant JOIN branch with the member count and an escape hatch to create', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({
      status: 'matched',
      company: { name: 'Northwind', memberCount: 42, joinMode: 'auto' },
    });
    renderStep();

    await screen.findByRole('heading', { name: /join northwind\?/i });
    expect(screen.getByText(/42 teammates already on balo/i)).toBeInTheDocument();

    // Escape hatch → CREATE branch.
    await user.click(screen.getByRole('button', { name: /this isn't my company/i }));
    expect(
      await screen.findByRole('heading', { name: /name your workspace/i })
    ).toBeInTheDocument();
  });

  it('fails open to an empty create form when the resolve RPC rejects', async () => {
    mockResolve.mockRejectedValue(new Error('rpc down'));
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
  });

  it('has no accessibility violations in the create state', async () => {
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    const { container } = renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
